// Pastas liberadas: transporte remoto (contrato §10.6–§10.8). RPC cifrado de ponta a ponta pelo WebSocket
// (`fs.request` → `fs.response`), eventos `fs.event` e conteúdo grande por blobs cifrados no spool da API.
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import {
  CHUNK_SIZE,
  FS_BLOB_SEGMENT_BYTES,
  FS_BLOB_TAG_BYTES,
  FS_EVENT_MAX_ENVELOPE_BYTES,
  FS_UPLOAD_COMMIT_WAIT_MS,
  FsE2eError,
  FsReplayGuard,
  deriveFsE2eKeys,
  fsBlobCipherSize,
  fsBlobSegment,
  fsError,
  newFsBlobSalt,
  openFsEnvelope,
  parseFsRequest,
  sealFsEnvelope,
  type FsBlobKey,
  type FsDownloadPrepared,
  type FsDownloadRequest,
  type FsE2eKeys,
  type FsEnvelope,
  type FsErrorBody,
  type FsEvent,
  type FsOutboxDownloadRequest,
  type FsRpcResult,
  type FsUploadCommitRequest,
  type FsUploadResult,
  type FsUploadState,
  type FsUploadStatusRequest,
  type FsUploadStatusResponse,
  type WsMessage,
} from '@arkivo/shared';
import { ApiClient, ApiError } from './api-client';
import { FsOpError, fsErrorFromErrno } from './fs-errors';
import { ConcurrencyLimiter } from './fs-limits';
import type { OutboxFile } from './fs-outbox';
import { ensurePartsDir, placeUpload, precheckUpload } from './fs-place';
import type { FsCallContext, FsRemoteOps, FsService } from './fs-service';
import { DiskError, isNoSpace, readJson, SerialQueue, writeFileAtomic, writeStreamDurable } from './fs-utils';
import { ONE_GIB } from './lan-server';
import { freeBytes as freeBytesOf } from './net-info';
import { sha256File } from './storage';
import { Logger, silentLogger } from './types';

/** Maior arquivo pela internet (o mesmo padrão de `FS_BLOB_MAX_BYTES` = `RELAY_MAX_FILE_BYTES` da API, 2 GiB). */
export const FS_REMOTE_MAX_BYTES = 2 * 1024 ** 3;
/** RPCs executando ao mesmo tempo no PC; acima → `fs.response { error: BUSY }`. */
export const FS_RPC_MAX_CONCURRENT = 16;
/** O PC guarda o estado de cada envio remoto por 24 h (§10.4 `uploadStatus`). */
export const FS_REMOTE_UPLOAD_STATE_TTL_MS = 24 * 3600_000;
export const FS_REMOTE_UPLOADS_FILE = 'fs-uploads.json';

export interface FsRemoteCreds {
  deviceId: string;
  pairKey: string;
  /** Celulares da conta (`GET /devices/pc/peers`). */
  allowedPhones: ReadonlySet<string>;
}

export interface FsRemoteOptions {
  service: FsService;
  api: ApiClient;
  /** Manda pelo WebSocket; `false` se desconectado. */
  send: (msg: WsMessage) => boolean;
  getCreds: () => FsRemoteCreds | null;
  dataDir: string;
  maxRemoteBytes?: number;
  commitWaitMs?: number;
  minFreeMarginBytes?: number;
  freeBytes?: (dir: string) => Promise<number>;
  retryBaseMs?: number;
  maxRetries?: number;
  now?: () => number;
  logger?: Logger;
}

interface UploadState {
  blobId: string;
  phoneId: string;
  requestKeys: string[];
  status: FsUploadState;
  received: number;
  size: number;
  rootId: string;
  path: string;
  name: string;
  result?: FsUploadResult;
  error?: FsErrorBody;
  updatedAt: number;
  /** Respondeu `pending`: avisar por `fs.event` quando terminar. */
  notify?: boolean;
}

/** O que `startBlob` cifra e envia. */
interface BlobSource {
  abs: string;
  size: number;
  mtimeMs: number;
  name: string;
  mime: string | null;
}

interface BlobHooks {
  onProgress?: (fraction: number) => void;
  onFailed?: (error: FsOpError) => Promise<void>;
  /** O usuário desistiu no PC: para de enviar. */
  cancelled?: () => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Erro da API ao mexer em blobs → código do contrato. */
export function blobApiError(err: unknown): FsOpError {
  if (err instanceof FsOpError) return err;
  if (err instanceof ApiError) {
    if (err.status === 413) return new FsOpError('TOO_LARGE');
    if (err.status === 429)
      return new FsOpError('RATE_LIMITED', 'Muitos arquivos passando pela internet agora. Tente de novo em instantes.');
    if (err.status === 507) return new FsOpError('BUSY', 'A fila temporária do servidor está cheia. Tente mais tarde.');
    if (err.status === 404 || err.status === 410) return new FsOpError('NOT_FOUND', 'O arquivo não está mais no servidor. Envie de novo.');
    if (err.status === 0) return new FsOpError('INTERNAL', 'O PC está sem conexão com o servidor.');
    return new FsOpError('INTERNAL');
  }
  if (err instanceof FsE2eError) return new FsOpError('HASH_MISMATCH');
  return fsErrorFromErrno(err, 'write');
}

export class FsRemote implements FsRemoteOps {
  private keyCache: { id: string; keys: Promise<FsE2eKeys> } | null = null;
  private readonly replay = new FsReplayGuard();
  private running = 0;
  private readonly downloads = new ConcurrencyLimiter(4);
  private readonly uploadsLimit = new ConcurrencyLimiter(2);
  private readonly uploads = new Map<string, UploadState>();
  private readonly byRequest = new Map<string, string>();
  /** §11: o blob de cada item da caixa de saída, para repetir `outboxDownload` sem cifrar e enviar de novo. */
  private readonly outboxBlobs = new Map<string, FsDownloadPrepared>();
  private readonly outboxStarting = new Map<string, Promise<FsDownloadPrepared>>();
  private readonly bg = new Set<Promise<unknown>>();
  private readonly file: string;
  private readonly writes = new SerialQueue();
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly o: FsRemoteOptions) {
    this.file = path.join(o.dataDir, FS_REMOTE_UPLOADS_FILE);
    this.log = o.logger ?? silentLogger;
    this.now = o.now ?? Date.now;
    o.service.remote = this;
  }

  // =================================================================== estado persistido dos envios

  async load(): Promise<void> {
    const stored = await readJson<UploadState[]>(this.file).catch(() => null);
    const t = this.now();
    for (const s of Array.isArray(stored) ? stored : []) {
      if (!s?.blobId || t - s.updatedAt > FS_REMOTE_UPLOAD_STATE_TTL_MS) continue;
      if (s.status === 'pending') {
        // O PC fechou no meio: o blob continua na API até o TTL; o celular pode repetir o `upload`.
        s.status = 'failed';
        s.error = fsError('INTERNAL', 'O PC foi fechado durante o envio. Tente de novo.');
      }
      this.uploads.set(s.blobId, s);
      for (const k of s.requestKeys ?? []) this.byRequest.set(k, s.blobId);
    }
  }

  private persist(): Promise<void> {
    const t = this.now();
    for (const [id, s] of this.uploads) {
      if (s.status !== 'pending' && t - s.updatedAt > FS_REMOTE_UPLOAD_STATE_TTL_MS) {
        this.uploads.delete(id);
        for (const k of s.requestKeys) this.byRequest.delete(k);
      }
    }
    const snap = JSON.stringify([...this.uploads.values()].map(({ notify: _n, ...s }) => s));
    return this.writes
      .run(() => writeFileAtomic(this.file, snap, 0o600, { logger: this.log }))
      .catch((err: unknown) => {
        this.log.warn('Falha ao gravar fs-uploads.json', err instanceof Error ? err.message : err);
      });
  }

  /** Espera os trabalhos em segundo plano (testes e encerramento). */
  async whenIdle(): Promise<void> {
    while (this.bg.size) await Promise.allSettled([...this.bg]);
  }

  private background(p: Promise<unknown>): void {
    const tracked = p.catch(() => undefined).finally(() => this.bg.delete(tracked));
    this.bg.add(tracked);
  }

  // =================================================================== chaves

  private keys(creds: FsRemoteCreds): Promise<FsE2eKeys> {
    const id = `${creds.deviceId}|${creds.pairKey}`;
    if (this.keyCache?.id !== id) {
      const keys = deriveFsE2eKeys(creds.pairKey, creds.deviceId);
      keys.catch(() => {
        if (this.keyCache?.keys === keys) this.keyCache = null;
      });
      this.keyCache = { id, keys };
    }
    return this.keyCache.keys;
  }

  // =================================================================== RPC

  /** `fs.request { rpcId, phoneDeviceId, envelope }` vindo da API. Sempre responde com `fs.response`. */
  async handleRequest(data: unknown): Promise<void> {
    const d = (data ?? {}) as { rpcId?: unknown; phoneDeviceId?: unknown; envelope?: unknown };
    if (typeof d.rpcId !== 'string' || !d.rpcId || d.rpcId.length > 128) return;
    const rpcId = d.rpcId;
    const fail = (code: 'E2E_FAILED' | 'CLOCK_SKEW' | 'BUSY') => this.o.send({ type: 'fs.response', data: { rpcId, error: { code } } });
    if (this.running >= FS_RPC_MAX_CONCURRENT) {
      fail('BUSY');
      return;
    }
    const creds = this.o.getCreds();
    if (!creds || typeof d.phoneDeviceId !== 'string') {
      fail('E2E_FAILED');
      return;
    }
    this.running++;
    try {
      const keys = await this.keys(creds);
      let env: FsEnvelope;
      let payload: unknown;
      try {
        const opened = await openFsEnvelope(keys, d.envelope, {
          typ: 'req',
          allowedPhones: creds.allowedPhones,
          replay: this.replay,
          now: this.now(),
        });
        env = opened.envelope;
        payload = opened.payload;
      } catch (err) {
        // O PC nunca cifra resposta para pedido que não abriu (§10.6).
        fail(err instanceof FsE2eError && err.code === 'EXPIRED' ? 'CLOCK_SKEW' : 'E2E_FAILED');
        return;
      }
      if (env.phone !== d.phoneDeviceId) {
        fail('E2E_FAILED');
        return;
      }
      const parsed = parseFsRequest(payload);
      const result: FsRpcResult = parsed.ok
        ? await this.o.service.execute({ phoneId: env.phone, via: 'remote' }, parsed.request)
        : { ok: false, error: parsed.error };
      let out: FsEnvelope;
      try {
        out = await sealFsEnvelope(keys, { phone: env.phone, typ: 'res', rid: env.rid, now: this.now() }, result);
      } catch (err) {
        // Só `list` corta a página para caber; o resto vira INTERNAL (§10.6).
        this.log.warn('Resposta remota grande demais', err instanceof Error ? err.message : err);
        out = await sealFsEnvelope(
          keys,
          { phone: env.phone, typ: 'res', rid: env.rid, now: this.now() },
          { ok: false, error: fsError('INTERNAL', 'Resposta grande demais.') },
        );
      }
      this.o.send({ type: 'fs.response', data: { rpcId, envelope: out } });
    } catch (err) {
      this.log.error('fs.request: erro inesperado', err);
      fail('E2E_FAILED');
    } finally {
      this.running--;
    }
  }

  /** `fs.event` cifrado para todos os celulares da conta (`phone: "*"`). Eventos só aceleram (§10.6). */
  async emitEvent(evt: FsEvent): Promise<boolean> {
    const creds = this.o.getCreds();
    if (!creds) return false;
    try {
      const keys = await this.keys(creds);
      const envelope = await sealFsEnvelope(keys, { phone: '*', typ: 'evt', now: this.now(), maxPlaintextBytes: 20 * 1024 }, evt);
      if (Buffer.byteLength(JSON.stringify(envelope)) > FS_EVENT_MAX_ENVELOPE_BYTES) return false;
      return this.o.send({ type: 'fs.event', data: { envelope } });
    } catch (err) {
      this.log.warn('fs.event não enviado', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private requireKeys(): Promise<FsE2eKeys> {
    const creds = this.o.getCreds();
    if (!creds) throw new FsOpError('INTERNAL', 'Este PC não está pareado.');
    return this.keys(creds);
  }

  // =================================================================== download remoto (PC → celular)

  async download(ctx: FsCallContext, req: FsDownloadRequest): Promise<FsDownloadPrepared> {
    const svc = this.o.service;
    const it = await svc.resolver.existing(req.rootId, req.path);
    if (it.stat.isDirectory()) throw new FsOpError('IS_A_DIRECTORY');
    if (!it.stat.isFile()) throw new FsOpError('NOT_FOUND');
    const size = it.stat.size;
    if (size > (this.o.maxRemoteBytes ?? FS_REMOTE_MAX_BYTES)) throw new FsOpError('TOO_LARGE');
    const entry = svc.entryOf(it);
    const prepared = await this.startBlob(ctx, { abs: it.abs, size, mtimeMs: Math.floor(it.stat.mtimeMs), name: entry.name, mime: entry.mime });
    svc.audit({
      phoneId: ctx.phoneId,
      phoneName: svc.phoneName(ctx.phoneId),
      via: 'remote',
      op: 'download',
      rootId: req.rootId,
      rootLabel: it.root.label,
      path: req.path,
      toPath: null,
      count: 1,
      bytes: size,
      result: 'ok',
    });
    return prepared;
  }

  /**
   * §11: como `download`, mas só alcança um item da caixa de saída deste celular. Repetir enquanto o blob do item
   * existe devolve o mesmo blob: nem cifra de novo, nem gasta outra vaga dos blobs ativos da conta.
   */
  async outboxDownload(ctx: FsCallContext, req: FsOutboxDownloadRequest): Promise<FsDownloadPrepared> {
    const outbox = this.o.service.outbox;
    if (!outbox) throw new FsOpError('UNSUPPORTED_OP');
    const file = await outbox.beginDelivery(ctx.phoneId, req.id, 'remote');
    const running = this.outboxStarting.get(file.id);
    if (running) return running;
    const start = this.startOutboxBlob(ctx, file).finally(() => this.outboxStarting.delete(file.id));
    this.outboxStarting.set(file.id, start);
    return start;
  }

  private async startOutboxBlob(ctx: FsCallContext, file: OutboxFile): Promise<FsDownloadPrepared> {
    const svc = this.o.service;
    const outbox = svc.outbox!;
    const current = this.outboxBlobs.get(file.id);
    if (current) {
      const info = await this.o.api.getFsBlob(current.blobId).catch(() => null);
      if (info && (info.status === 'uploading' || info.status === 'ready' || info.status === 'downloading')) return current;
      this.outboxBlobs.delete(file.id);
    }
    try {
      const prepared = await this.startBlob(ctx, file, {
        onProgress: (fraction) => outbox.progress(file.id, fraction * file.size),
        cancelled: () => !outbox.isActive(file.id),
        onFailed: async (fe) => {
          this.outboxBlobs.delete(file.id);
          if (fe.code === 'CHANGED') await outbox.markChanged(file.id);
          else await outbox.release(file.id);
        },
      });
      this.outboxBlobs.set(file.id, prepared);
      svc.auditOutbox(ctx, 'outboxDownload', file.name, file.size);
      return prepared;
    } catch (err) {
      await outbox.release(file.id);
      throw err;
    }
  }

  /** Reserva o blob e responde já; cifra e envia em segundo plano (§10.7 passo 2). */
  private async startBlob(ctx: FsCallContext, src: BlobSource, hooks: BlobHooks = {}): Promise<FsDownloadPrepared> {
    const release = this.downloads.acquire(ctx.phoneId);
    if (!release) throw new FsOpError('RATE_LIMITED', 'Muitos downloads ao mesmo tempo. Espere um terminar.');
    try {
      const keys = await this.requireKeys();
      const cipherSize = fsBlobCipherSize(src.size);
      let blobId: string;
      try {
        blobId = (await this.o.api.createFsBlob({ cipherSize })).id;
      } catch (err) {
        throw blobApiError(err);
      }
      const blobSalt = newFsBlobSalt();
      const fp = { size: src.size, mtimeMs: src.mtimeMs };
      this.background(this.runDownload(keys, blobId, blobSalt, src.abs, fp, hooks).finally(release));
      return {
        blobId,
        blobSalt,
        name: src.name,
        size: src.size,
        mime: src.mime,
        mtime: new Date(src.mtimeMs).toISOString(),
        cipherSize,
        etag: `"${src.size}-${src.mtimeMs}"`,
      };
    } catch (err) {
      release();
      throw err;
    }
  }

  private async runDownload(
    keys: FsE2eKeys,
    blobId: string,
    salt: string,
    abs: string,
    fp: { size: number; mtimeMs: number },
    hooks: BlobHooks,
  ): Promise<void> {
    let fh: FileHandle | null = null;
    try {
      const key = await keys.blobKey(blobId, salt, fp.size);
      fh = await fsp.open(abs, 'r');
      const handle = fh;
      const changed = async () => {
        if (hooks.cancelled?.()) return true;
        const [a, b] = await Promise.all([handle.stat(), fsp.stat(abs).catch(() => null)]);
        const same = (s: { size: number; mtimeMs: number } | null) => !!s && s.size === fp.size && Math.floor(s.mtimeMs) === fp.mtimeMs;
        return !same(a) || !same(b);
      };
      const reader = new BlobReader(handle, key, fp.size);
      // 1ª passada: SHA-256 do blob cifrado (a cifra é determinística, §10.7).
      const h = createHash('sha256');
      for (let i = 0; i < key.segmentCount; i++) h.update(await reader.sealed(i));
      if (await changed()) throw new FsOpError('CHANGED');
      // 2ª passada: PUT em pedaços de 8 MiB, retomando com HEAD.
      await this.putBlob(blobId, key.cipherSize, h.digest('hex'), reader, changed, hooks.onProgress);
    } catch (err) {
      const fe = blobApiError(err);
      this.log.warn(`Download remoto ${blobId}: ${fe.code} ${fe.message}`);
      await this.o.api.failFsBlob(blobId, fe.code === 'CHANGED' ? 'changed' : fe.code.toLowerCase()).catch(() => undefined);
      await hooks.onFailed?.(fe).catch(() => undefined);
      await this.emitEvent({ kind: 'downloadFailed', blobId, error: fe.body });
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private async putBlob(
    blobId: string,
    total: number,
    hash: string,
    reader: BlobReader,
    changed: () => Promise<boolean>,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const single = total <= CHUNK_SIZE;
    const api = this.o.api;
    let received = single ? 0 : await api.headFsBlobContent(blobId).catch(() => 0);
    let failures = 0;
    for (let guard = 0; guard < 100_000; guard++) {
      if (await changed()) throw new FsOpError('CHANGED');
      if (received > total) received = 0;
      // Tudo recebido mas sem "pronto": reenvia o último pedaço para a API concluir (§4.1).
      const start = single ? 0 : received >= total ? total - (total % CHUNK_SIZE || CHUNK_SIZE) : received;
      const end = single ? total : Math.min(start + CHUNK_SIZE, total);
      const data = await reader.range(start, end);
      let r: { status: number; received: number | null };
      try {
        r = await api.putFsBlobChunk(blobId, data, { start, total, hash, single });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) throw new FsOpError('CHANGED');
        if (err instanceof ApiError && err.retryable && failures < (this.o.maxRetries ?? 5)) {
          failures++;
          await sleep((this.o.retryBaseMs ?? 1000) * 2 ** (failures - 1));
          if (!single) received = await api.headFsBlobContent(blobId).catch(() => received);
          continue;
        }
        throw err;
      }
      if (r.status === 200 || r.status === 201) {
        onProgress?.(1);
        return;
      }
      if (r.status === 202) {
        failures = 0;
        received = r.received ?? end;
        onProgress?.(total ? received / total : 1);
        continue;
      }
      if (r.status === 416) {
        if (++failures > (this.o.maxRetries ?? 5)) throw new FsOpError('INTERNAL', 'O servidor recusou a retomada.');
        received = r.received ?? (await api.headFsBlobContent(blobId).catch(() => 0));
        continue;
      }
      if (r.status === 423) {
        if (++failures > (this.o.maxRetries ?? 5) * 4) throw new FsOpError('BUSY');
        await sleep(this.o.retryBaseMs ?? 1000);
        continue;
      }
      throw new FsOpError('INTERNAL');
    }
    throw new FsOpError('INTERNAL');
  }

  // =================================================================== envio remoto (celular → PC)

  async upload(ctx: FsCallContext, req: FsUploadCommitRequest): Promise<FsUploadStatusResponse> {
    const reqKey = `${ctx.phoneId}|${req.requestId}`;
    const mapped = this.byRequest.get(reqKey);
    const existing = this.uploads.get(mapped ?? req.blobId);
    if (existing && (existing.status === 'pending' || existing.status === 'done' || mapped)) {
      // Mesma ação repetida (mesmo `requestId`) ou envio deste blob em andamento/concluído: devolve o estado.
      if (!existing.requestKeys.includes(reqKey)) existing.requestKeys.push(reqKey);
      this.byRequest.set(reqKey, existing.blobId);
      return snapshot(existing);
    }
    const svc = this.o.service;
    const policy = req.onConflict ?? 'rename';
    if (req.size > (this.o.maxRemoteBytes ?? FS_REMOTE_MAX_BYTES)) throw new FsOpError('TOO_LARGE');
    // Destino e conflito conferidos antes de baixar (CONFLICT sem gastar banda, §10.7 passo 3).
    await precheckUpload(svc, req.rootId, req.path, req.name, policy);
    const dir = await svc.resolver.directory(req.rootId, req.path);
    const free = await (this.o.freeBytes ?? freeBytesOf)(dir.rootReal).catch(() => Number.MAX_SAFE_INTEGER);
    if (free < req.size + (this.o.minFreeMarginBytes ?? ONE_GIB)) throw new FsOpError('NO_SPACE');
    const release = this.uploadsLimit.acquire(ctx.phoneId);
    if (!release) throw new FsOpError('RATE_LIMITED', 'Muitos envios ao mesmo tempo. Espere um terminar.');
    const keys = await this.requireKeys().catch((err: unknown) => {
      release();
      throw err;
    });
    const st: UploadState = {
      blobId: req.blobId,
      phoneId: ctx.phoneId,
      requestKeys: [reqKey],
      status: 'pending',
      received: 0,
      size: req.size,
      rootId: req.rootId,
      path: req.path,
      name: req.name,
      updatedAt: this.now(),
    };
    this.uploads.set(req.blobId, st);
    this.byRequest.set(reqKey, req.blobId);
    void this.persist();
    const job = this.runUpload(ctx, req, st, keys).finally(release);
    this.background(job);
    const wait = this.o.commitWaitMs ?? FS_UPLOAD_COMMIT_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job, new Promise((r) => (timer = setTimeout(r, wait)))]);
    clearTimeout(timer);
    if (st.status === 'pending') st.notify = true;
    return snapshot(st);
  }

  uploadStatus(_ctx: FsCallContext, req: FsUploadStatusRequest): Promise<FsUploadStatusResponse> {
    const st = this.uploads.get(req.blobId);
    if (!st) return Promise.reject(new FsOpError('NOT_FOUND', 'O PC não conhece este envio.'));
    return Promise.resolve(snapshot(st));
  }

  private async runUpload(ctx: FsCallContext, req: FsUploadCommitRequest, st: UploadState, keys: FsE2eKeys): Promise<void> {
    const svc = this.o.service;
    const label = svc.roots.get(req.rootId)?.label ?? null;
    const audit = (result: 'ok' | FsErrorBody['code'], p: string | null) =>
      svc.audit({
        phoneId: ctx.phoneId,
        phoneName: svc.phoneName(ctx.phoneId),
        via: 'remote',
        op: 'upload',
        rootId: req.rootId,
        rootLabel: label,
        path: p,
        toPath: null,
        count: 1,
        bytes: req.size,
        result,
      });
    let part: string | null = null;
    try {
      const dir = await svc.resolver.directory(req.rootId, req.path);
      const partsDir = await ensurePartsDir(dir.rootReal);
      part = path.join(partsDir, `blob-${req.blobId}.part`);
      let info;
      try {
        info = await this.o.api.getFsBlob(req.blobId);
      } catch (err) {
        throw blobApiError(err);
      }
      if (info.direction !== 'toPc') throw new FsOpError('VALIDATION_ERROR', 'Este blob não é para o PC.');
      if (info.cipherSize !== fsBlobCipherSize(req.size)) throw new FsOpError('VALIDATION_ERROR', 'O tamanho não bate com o blob enviado.');
      if (info.status === 'uploading') throw new FsOpError('VALIDATION_ERROR', 'O envio ainda não terminou no servidor.');
      if (info.status !== 'ready' && info.status !== 'downloading')
        throw new FsOpError('NOT_FOUND', 'O arquivo não está mais no servidor. Envie de novo.');
      const key = await keys.blobKey(req.blobId, req.blobSalt, req.size);
      await this.fetchBlob(req.blobId, key, part, st);
      // Confere tamanho e SHA-256 do texto claro, relendo o `.part` já sincronizado (§10.7 passo 3).
      const size = (await fsp.stat(part)).size;
      const sha = size === req.size ? await sha256File(part) : '';
      if (sha !== req.sha256) {
        await fsp.rm(part, { force: true });
        await this.o.api.deleteFsBlob(req.blobId).catch(() => undefined);
        throw new FsOpError('HASH_MISMATCH');
      }
      const result = await placeUpload(svc, {
        rootId: req.rootId,
        dirRel: req.path,
        name: req.name,
        policy: req.onConflict ?? 'rename',
        partPath: part,
        hash: sha,
      });
      await this.o.api
        .deleteFsBlob(req.blobId)
        .catch((err: unknown) => this.log.warn(`DELETE do blob ${req.blobId} falhou`, err instanceof Error ? err.message : err));
      st.status = 'done';
      st.received = req.size;
      st.result = result;
      st.updatedAt = this.now();
      audit('ok', result.path);
      void this.persist();
      if (st.notify) await this.emitEvent({ kind: 'uploadDone', blobId: req.blobId, result });
    } catch (err) {
      const fe = blobApiError(err);
      if (fe.code === 'INTERNAL') this.log.warn(`Envio remoto ${req.blobId}`, err instanceof Error ? err.message : err);
      // Disco cheio: o `.part` e o blob ficam (o celular repete o `upload` depois de liberar espaço, §10.7 passo 4).
      if (part && fe.code !== 'NO_SPACE' && fe.code !== 'INTERNAL') await fsp.rm(part, { force: true }).catch(() => undefined);
      st.status = 'failed';
      st.error = fe.body;
      st.updatedAt = this.now();
      audit(fe.code, joinPath(req.path, req.name));
      void this.persist();
      if (st.notify) await this.emitEvent({ kind: 'uploadFailed', blobId: req.blobId, error: fe.body });
    }
  }

  /**
   * Baixa o blob (retomando com `Range` no começo de um pedaço) e decifra pedaço a pedaço para o `.part`.
   * Um pedaço que não abre: baixa aquele trecho de novo uma vez; repetiu → `HASH_MISMATCH`.
   */
  private async fetchBlob(blobId: string, key: FsBlobKey, part: string, st: UploadState): Promise<void> {
    const size = key.plainSize;
    const count = key.segmentCount;
    let decryptFailures = 0;
    let netFailures = 0;
    for (;;) {
      const have = await fsp.stat(part).then(
        (s) => s.size,
        () => -1,
      );
      let seg = have < 0 || have > size ? 0 : Math.floor(have / FS_BLOB_SEGMENT_BYTES);
      if (have === size && have >= 0 && size > 0) seg = count;
      if (seg >= count && have === size) return;
      const plainStart = seg * FS_BLOB_SEGMENT_BYTES;
      if (have < 0) await fsp.writeFile(part, '');
      await fsp.truncate(part, plainStart);
      const offset = fsBlobSegment(size, seg).cipherStart;
      let res: Response;
      try {
        res = await this.o.api.downloadFsBlob(blobId, offset);
      } catch (err) {
        if (err instanceof ApiError && err.retryable && netFailures++ < (this.o.maxRetries ?? 5)) {
          await sleep((this.o.retryBaseMs ?? 1000) * 2 ** (netFailures - 1));
          continue;
        }
        throw blobApiError(err);
      }
      let skip = 0;
      if (res.status === 416) {
        await res.body?.cancel().catch(() => undefined);
        await fsp.truncate(part, 0);
        if (netFailures++ >= (this.o.maxRetries ?? 5)) throw new FsOpError('INTERNAL', 'O servidor recusou a retomada.');
        continue;
      }
      if (res.status === 200 && offset > 0) skip = offset; // o servidor ignorou o Range
      if (res.status === 206) {
        const cr = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
        if (!cr || Number(cr[1]) !== offset) {
          await res.body?.cancel().catch(() => undefined);
          throw new FsOpError('INTERNAL', 'Resposta parcial inesperada do servidor.');
        }
      }
      if (!res.body) throw new FsOpError('INTERNAL', 'Download sem conteúdo.');
      let next = seg;
      let buf: Buffer = Buffer.alloc(0);
      const decrypt = new Transform({
        transform(chunk: Buffer, _e, cb) {
          const run = async () => {
            let c: Buffer = chunk;
            if (skip > 0) {
              const n = Math.min(skip, c.length);
              c = c.subarray(n);
              skip -= n;
            }
            buf = buf.length ? Buffer.concat([buf, c]) : c;
            while (next < count) {
              const s = fsBlobSegment(size, next);
              if (buf.length < s.cipherLength) break;
              const plain = await key.openSegment(next, new Uint8Array(buf.subarray(0, s.cipherLength)));
              buf = buf.subarray(s.cipherLength);
              this.push(Buffer.from(plain));
              next++;
              st.received = s.plainStart + s.plainLength;
            }
            if (next >= count && buf.length > 0) throw new FsOpError('HASH_MISMATCH');
          };
          run().then(() => cb(), cb);
        },
      });
      try {
        await writeStreamDurable(part, [Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), decrypt], {
          flags: 'a',
        });
      } catch (err) {
        if (err instanceof DiskError)
          throw isNoSpace(err) ? new FsOpError('NO_SPACE') : new FsOpError('INTERNAL', 'Erro ao gravar no disco do PC.');
        if (err instanceof FsE2eError) {
          if (++decryptFailures > 1) throw new FsOpError('HASH_MISMATCH');
          continue; // baixa aquele trecho de novo (o `.part` é cortado no último pedaço inteiro)
        }
        if (err instanceof FsOpError) throw err;
        if (netFailures++ < (this.o.maxRetries ?? 5)) {
          await sleep((this.o.retryBaseMs ?? 1000) * 2 ** (netFailures - 1));
          continue;
        }
        throw new FsOpError('INTERNAL', 'O download do servidor foi interrompido.');
      }
      if (next >= count) return;
      if (netFailures++ >= (this.o.maxRetries ?? 5)) throw new FsOpError('INTERNAL', 'O download do servidor foi interrompido.');
    }
  }
}

function snapshot(st: UploadState): FsUploadStatusResponse {
  const r: FsUploadStatusResponse = { blobId: st.blobId, status: st.status, received: st.received };
  if (st.result) r.result = st.result;
  if (st.error) r.error = st.error;
  return r;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Lê pedaços do arquivo e os cifra (de novo, idênticos) para qualquer faixa do blob. */
class BlobReader {
  constructor(
    private readonly fh: FileHandle,
    private readonly key: FsBlobKey,
    private readonly size: number,
  ) {}

  async plain(i: number): Promise<Uint8Array> {
    const s = fsBlobSegment(this.size, i);
    const buf = Buffer.alloc(s.plainLength);
    let off = 0;
    while (off < s.plainLength) {
      const { bytesRead } = await this.fh.read(buf, off, s.plainLength - off, s.plainStart + off);
      if (bytesRead === 0) throw new FsOpError('CHANGED');
      off += bytesRead;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  }

  async sealed(i: number): Promise<Uint8Array> {
    return this.key.sealSegment(i, await this.plain(i));
  }

  /** Bytes `[start, end)` do blob cifrado. */
  async range(start: number, end: number): Promise<Uint8Array> {
    const first = Math.floor(start / (FS_BLOB_SEGMENT_BYTES + FS_BLOB_TAG_BYTES));
    const parts: Uint8Array[] = [];
    let i = first;
    for (;;) {
      const s = fsBlobSegment(this.size, i);
      parts.push(await this.sealed(i));
      if (s.last || s.cipherStart + s.cipherLength >= end) break;
      i++;
    }
    const all = Buffer.concat(parts);
    const off = start - fsBlobSegment(this.size, first).cipherStart;
    return all.subarray(off, off + (end - start));
  }
}
