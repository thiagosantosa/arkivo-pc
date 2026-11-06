// Pastas liberadas: despachante único das operações (contrato §10.4), usado pelas duas vias (LAN e remoto).
// Valida, resolve caminhos, aplica limites, idempotência e auditoria; o transporte só cuida de bytes e envelopes.
import { randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  FS_LIST_DEFAULT_LIMIT,
  FS_MUTATING_OPS,
  FS_OUTBOX_OPS,
  FS_REMOTE_ONLY_OPS,
  FS_RPC_MAX_PLAINTEXT_BYTES,
  FS_THUMB_DEFAULT_SIZE,
  checkFsName,
  compareFsEntries,
  fsCollisionName,
  fsMimeFromName,
  fsParentPath,
  fsThumbCandidate,
  isAbsPathInside,
  isFsHiddenName,
  joinFsPath,
  type FsBatchItemResult,
  type FsBatchResponse,
  type FsEntry,
  type FsEntryResponse,
  type FsErrorBody,
  type FsListRequest,
  type FsListResponse,
  type FsMkdirRequest,
  type FsMkdirResponse,
  type FsMoveRequest,
  type FsOp,
  type FsOutboxDownloadRequest,
  type FsOutboxItemResponse,
  type FsOutboxListResponse,
  type FsPlatform,
  type FsRenameRequest,
  type FsRequest,
  type FsRootsResponse,
  type FsRpcResult,
  type FsStatRequest,
  type FsStatResponse,
  type FsThumbRequest,
  type FsThumbResponse,
  type FsTrashRequest,
  type FsUploadCommitRequest,
  type FsDownloadRequest,
  type FsUploadStatusRequest,
} from '@arkivo/shared';
import { noDirAttributes, type DirAttributeProbe, type DirAttributes } from './fs-attrs';
import type { FsAuditInput, FsAuditLog } from './fs-audit';
import { DRIVE_ROOT_MKDIR_MESSAGE, driveRootWriteError, FsOpError, fsErrorFromErrno } from './fs-errors';
import { ConcurrencyLimiter, IdempotencyCache, RateLimiter } from './fs-limits';
import type { FsOutbox } from './fs-outbox';
import type { FsPlatformAdapter } from './fs-platform';
import { FsResolver, samePath, type ResolvedItem } from './fs-resolve';
import type { RootRegistry } from './fs-roots';
import { ThumbService, type ThumbResult } from './fs-thumbs';
import { errnoCode, fsyncDir, renameWithRetry, SerialQueue } from './fs-utils';
import type { VolumeProbe } from './fs-volume';
import { Logger, silentLogger } from './types';

export type FsVia = 'lan' | 'remote';

export interface FsCallContext {
  phoneId: string;
  via: FsVia;
}

/** Operações que só existem pela internet (blobs cifrados, §10.7). Implementadas em `fs-remote.ts`. */
export interface FsRemoteOps {
  download(ctx: FsCallContext, req: FsDownloadRequest): Promise<unknown>;
  upload(ctx: FsCallContext, req: FsUploadCommitRequest): Promise<unknown>;
  uploadStatus(ctx: FsCallContext, req: FsUploadStatusRequest): Promise<unknown>;
  outboxDownload(ctx: FsCallContext, req: FsOutboxDownloadRequest): Promise<unknown>;
}

export interface FsServiceOptions {
  roots: RootRegistry;
  /** Caixa de saída de "Enviar para o celular" (§11). Ausente → `UNSUPPORTED_OP`. */
  outbox?: FsOutbox;
  platform: FsPlatformAdapter;
  volumes: VolumeProbe;
  audit: FsAuditLog;
  pcName: () => string;
  phoneName?: (phoneId: string) => string | null;
  /** Atributos oculto/offline do Windows (padrão: nenhum). */
  dirAttributes?: DirAttributeProbe;
  /** Procura NFC/NFD no disco (padrão: Linux). */
  normalizationFallback?: boolean;
  /** Limites por celular (§10.10). */
  readPerSecond?: number;
  writePerSecond?: number;
  lanDownloadsPerPhone?: number;
  now?: () => number;
  logger?: Logger;
}

export const FS_READ_OPS: readonly FsOp[] = ['roots', 'list', 'stat', 'thumb', 'uploadStatus', 'outboxList'];
/** Guarda das listagens para o `cursor` (§10.4). */
export const FS_LIST_SNAPSHOT_TTL_MS = 60_000;
const CURSOR_RE = /^([A-Za-z0-9_-]{8,40})\.(\d{1,9})$/;

interface SnapItem {
  name: string;
  diskName: string;
  type: 'file' | 'dir';
  hidden: boolean;
  /** `stat` seguindo o link (preenchido sob demanda quando a ordem é por nome). */
  entry?: FsEntry | null;
}

interface Snapshot {
  id: string;
  key: string;
  at: number;
  dirAbs: string;
  items: SnapItem[];
  omitted: number;
  offline: Set<string>;
}

export class FsService {
  readonly resolver: FsResolver;
  readonly thumbs: ThumbService;
  private readonly idem: IdempotencyCache;
  private readonly readRate: RateLimiter;
  private readonly writeRate: RateLimiter;
  readonly lanDownloads: ConcurrencyLimiter;
  /** Mudanças no disco uma de cada vez (evita corrida entre conferir conflito e renomear). */
  readonly mutations = new SerialQueue();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly dirAttrs: DirAttributeProbe;
  private readonly log: Logger;
  private readonly now: () => number;
  remote: FsRemoteOps | null = null;

  constructor(private readonly o: FsServiceOptions) {
    this.now = o.now ?? Date.now;
    this.resolver = new FsResolver({ roots: o.roots, normalizationFallback: o.normalizationFallback });
    this.thumbs = new ThumbService({ platform: o.platform });
    this.idem = new IdempotencyCache(undefined, this.now);
    this.readRate = new RateLimiter(o.readPerSecond ?? 20, this.now);
    this.writeRate = new RateLimiter(o.writePerSecond ?? 5, this.now);
    this.lanDownloads = new ConcurrencyLimiter(o.lanDownloadsPerPhone ?? 4);
    this.dirAttrs = o.dirAttributes ?? noDirAttributes;
    this.log = o.logger ?? silentLogger;
  }

  get roots(): RootRegistry {
    return this.o.roots;
  }

  get platform(): FsPlatformAdapter {
    return this.o.platform;
  }

  get volumes(): VolumeProbe {
    return this.o.volumes;
  }

  get outbox(): FsOutbox | null {
    return this.o.outbox ?? null;
  }

  private requireOutbox(): FsOutbox {
    if (!this.o.outbox) throw new FsOpError('UNSUPPORTED_OP');
    return this.o.outbox;
  }

  get fsPlatform(): FsPlatform {
    return this.o.roots.platform;
  }

  phoneName(phoneId: string): string | null {
    return this.o.phoneName?.(phoneId) ?? null;
  }

  // =================================================================== porta de entrada

  /**
   * Barreira comum às duas vias: interruptor e limite de taxa. Lança `FsOpError`.
   * `op` decide a classe do limite (leitura 20/s, mudança 5/s). A caixa de saída (§11) independe do interruptor: o
   * pedido só leva o `id` de um item escolhido pelo usuário, nunca um caminho.
   */
  gate(ctx: FsCallContext, op: FsOp): void {
    if (!this.o.roots.enabled && !FS_OUTBOX_OPS.includes(op)) throw new FsOpError('FS_DISABLED');
    const limiter = FS_READ_OPS.includes(op) ? this.readRate : this.writeRate;
    if (!limiter.take(ctx.phoneId)) throw new FsOpError('RATE_LIMITED');
  }

  /** Executa um pedido já validado por `parseFsRequest`. Nunca lança: erros saem em `{ ok: false, error }`. */
  async execute(ctx: FsCallContext, req: FsRequest): Promise<FsRpcResult> {
    try {
      this.gate(ctx, req.op);
      if (ctx.via === 'lan' && FS_REMOTE_ONLY_OPS.includes(req.op))
        throw new FsOpError('UNSUPPORTED_OP', 'Na mesma rede, use as rotas de download e envio.');
      if (req.op === 'mkdir' || req.op === 'rename' || req.op === 'move' || req.op === 'trash') {
        return await this.idem.run(IdempotencyCache.key(ctx.phoneId, req.requestId), () => this.wrap(() => this.mutate(ctx, req)));
      }
      return await this.wrap(() => this.dispatch(ctx, req));
    } catch (err) {
      return { ok: false, error: this.errorBody(err, req.op) };
    }
  }

  private async wrap(fn: () => Promise<unknown>): Promise<FsRpcResult> {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      return { ok: false, error: this.errorBody(err) };
    }
  }

  errorBody(err: unknown, op?: FsOp): FsErrorBody {
    if (err instanceof FsOpError) return err.body;
    const mapped = fsErrorFromErrno(err, op && FS_MUTATING_OPS.includes(op) ? 'write' : 'read');
    if (mapped.code === 'INTERNAL') this.log.warn('Pastas liberadas: erro inesperado', err instanceof Error ? err.message : err);
    return mapped.body;
  }

  private async dispatch(ctx: FsCallContext, req: FsRequest): Promise<unknown> {
    switch (req.op) {
      case 'roots':
        return this.rootsResponse();
      case 'list':
        this.browse(ctx);
        return this.list(ctx, req);
      case 'stat':
        this.browse(ctx);
        return this.stat(req);
      case 'thumb': {
        this.browse(ctx);
        const t = await this.thumbnail(req);
        return {
          mime: 'image/jpeg',
          width: t.width,
          height: t.height,
          dataB64: t.jpeg.toString('base64'),
          etag: t.etag,
        } satisfies FsThumbResponse;
      }
      case 'download':
      case 'upload':
      case 'uploadStatus': {
        const remote = this.remote;
        if (!remote) throw new FsOpError('UNSUPPORTED_OP');
        if (req.op === 'download') return remote.download(ctx, req);
        if (req.op === 'upload') return remote.upload(ctx, req);
        return remote.uploadStatus(ctx, req);
      }
      case 'outboxList':
        return {
          items: await this.requireOutbox().listFor(ctx.phoneId),
          pcName: this.o.pcName(),
        } satisfies FsOutboxListResponse;
      case 'outboxDownload': {
        this.requireOutbox();
        if (!this.remote) throw new FsOpError('UNSUPPORTED_OP');
        return this.remote.outboxDownload(ctx, req);
      }
      case 'outboxDone': {
        const r = await this.requireOutbox().done(ctx.phoneId, req.id);
        if (r.transitioned) this.auditOutbox(ctx, 'outboxDone', r.item.name, r.item.size);
        return { item: r.item } satisfies FsOutboxItemResponse;
      }
      case 'outboxDecline': {
        const r = await this.requireOutbox().decline(ctx.phoneId, req.id);
        if (r.transitioned) this.auditOutbox(ctx, 'outboxDecline', r.item.name, r.item.size);
        return { item: r.item } satisfies FsOutboxItemResponse;
      }
      default:
        throw new FsOpError('UNSUPPORTED_OP');
    }
  }

  private async mutate(ctx: FsCallContext, req: FsMkdirRequest | FsRenameRequest | FsMoveRequest | FsTrashRequest): Promise<unknown> {
    const label = this.o.roots.get(req.rootId)?.label ?? null;
    const base = {
      phoneId: ctx.phoneId,
      phoneName: this.phoneName(ctx.phoneId),
      via: ctx.via,
      op: req.op,
      rootId: req.rootId,
      rootLabel: label,
      bytes: null,
    };
    try {
      const r = await this.mutations.run(() => this.mutateNow(req));
      if (req.op === 'move' || req.op === 'trash') {
        const results = (r as FsBatchResponse).results;
        const okCount = results.filter((x) => x.ok && !('skipped' in x && x.skipped)).length;
        const firstErr = results.find((x): x is Extract<FsBatchItemResult, { ok: false }> => !x.ok);
        this.audit({
          ...base,
          path: req.paths.length === 1 ? req.paths[0] : null,
          toPath: req.op === 'move' ? req.toPath : null,
          count: okCount || req.paths.length,
          result: okCount === 0 && firstErr ? firstErr.error.code : 'ok',
        });
      } else if (req.op === 'mkdir') {
        this.audit({ ...base, path: (r as FsMkdirResponse).path, toPath: null, count: 1, result: 'ok' });
      } else {
        this.audit({ ...base, path: req.path, toPath: (r as FsEntryResponse).path, count: 1, result: 'ok' });
      }
      return r;
    } catch (err) {
      const body = this.errorBody(err, req.op);
      const p =
        req.op === 'mkdir' ? joinFsPath(req.path, req.name) : req.op === 'rename' ? req.path : req.paths.length === 1 ? req.paths[0] : null;
      this.audit({
        ...base,
        path: p,
        toPath: req.op === 'move' ? req.toPath : null,
        count: req.op === 'move' || req.op === 'trash' ? req.paths.length : 1,
        result: body.code,
      });
      throw err;
    }
  }

  private mutateNow(req: FsMkdirRequest | FsRenameRequest | FsMoveRequest | FsTrashRequest): Promise<unknown> {
    switch (req.op) {
      case 'mkdir':
        return this.mkdir(req);
      case 'rename':
        return this.rename(req);
      case 'move':
        return this.move(req);
      case 'trash':
        return this.trash(req);
    }
  }

  audit(e: FsAuditInput): void {
    this.o.audit.record(e);
  }

  /** Histórico "O que o celular fez" da caixa de saída (§11): só o nome do arquivo, sem raiz. */
  auditOutbox(ctx: FsCallContext, op: 'outboxDownload' | 'outboxDone' | 'outboxDecline', name: string, bytes: number): void {
    this.audit({
      phoneId: ctx.phoneId,
      phoneName: this.phoneName(ctx.phoneId),
      via: ctx.via,
      op,
      rootId: null,
      rootLabel: null,
      path: name,
      toPath: null,
      count: 1,
      bytes,
      result: 'ok',
    });
  }

  private browse(ctx: FsCallContext): void {
    this.o.audit.browse(ctx.phoneId, this.phoneName(ctx.phoneId), ctx.via);
  }

  /** Registra a navegação de uma rota LAN binária (`thumb`). */
  browseFrom(ctx: FsCallContext): void {
    this.browse(ctx);
  }

  // =================================================================== roots

  async rootsResponse(): Promise<FsRootsResponse> {
    const infos = await this.o.roots.infos();
    return {
      roots: infos.map(({ absPath: _a, ...info }) => info),
      pcName: this.o.pcName(),
      platform: this.fsPlatform,
    };
  }

  // =================================================================== entradas

  entryFor(name: string, st: Stats, o: { hidden?: boolean; offline?: boolean } = {}): FsEntry {
    const nfc = name.normalize('NFC');
    const isDir = st.isDirectory();
    const mime = isDir ? null : fsMimeFromName(nfc);
    return {
      name: nfc,
      type: isDir ? 'dir' : 'file',
      size: isDir ? null : st.size,
      mtime: new Date(Math.floor(st.mtimeMs)).toISOString(),
      mime,
      hidden: o.hidden ?? isFsHiddenName(nfc),
      hasThumb: !isDir && !o.offline && fsThumbCandidate(mime) && this.o.platform.canThumbnail(mime),
    };
  }

  /** Entrada de um item resolvido (o nome da raiz é o rótulo). */
  entryOf(it: ResolvedItem): FsEntry {
    const name = it.rel === '' ? it.root.label : it.diskName;
    return this.entryFor(name, it.stat);
  }

  // =================================================================== list

  async list(ctx: FsCallContext, req: FsListRequest): Promise<FsListResponse> {
    const limit = req.limit ?? FS_LIST_DEFAULT_LIMIT;
    let offset = 0;
    let snap: Snapshot | undefined;
    const key = [ctx.phoneId, req.rootId, req.path, req.sort ?? 'name', req.order ?? 'asc', req.includeHidden ? 1 : 0].join('|');
    this.pruneSnapshots();
    if (req.cursor !== undefined) {
      const m = CURSOR_RE.exec(req.cursor);
      if (!m) throw new FsOpError('VALIDATION_ERROR', 'cursor: inválido.');
      offset = Number(m[2]);
      const s = this.snapshots.get(m[1]);
      if (s && s.key === key) snap = s;
    }
    // Sempre resolve de novo: a raiz pode ter sido removida ou desconectada desde a última página.
    const dir = await this.resolver.directory(req.rootId, req.path);
    if (!snap || !samePath(snap.dirAbs, dir.abs, this.resolver.caseInsensitive)) snap = await this.snapshot(key, dir, req);

    const page: { consumed: number; entry: FsEntry }[] = [];
    let i = offset;
    for (; i < snap.items.length && page.length < limit; i++) {
      const item = snap.items[i];
      if (item.entry === undefined) item.entry = await this.statItem(snap, item);
      if (item.entry) page.push({ consumed: i + 1, entry: item.entry });
    }
    const build = (n: number): FsListResponse => {
      const end = n === page.length ? i : (page[n - 1]?.consumed ?? offset);
      return {
        rootId: req.rootId,
        path: req.path,
        entries: page.slice(0, n).map((p) => p.entry),
        nextCursor: end < snap.items.length ? `${snap.id}.${end}` : null,
        total: snap.items.length,
        omitted: snap.omitted,
      };
    };
    let res = build(page.length);
    if (ctx.via === 'remote') {
      // A página precisa caber no envelope (§10.4): menos itens + `nextCursor`.
      const max = FS_RPC_MAX_PLAINTEXT_BYTES - 1024;
      let n = page.length;
      while (n > 1 && Buffer.byteLength(JSON.stringify({ ok: true, data: res })) > max) {
        n = Math.max(1, Math.floor(n * 0.75));
        res = build(n);
      }
    }
    return res;
  }

  private async snapshot(key: string, dir: ResolvedItem, req: FsListRequest): Promise<Snapshot> {
    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch (err) {
      throw fsErrorFromErrno(err, 'read');
    }
    const attrs: DirAttributes = await this.dirAttrs(dir.abs).catch(() => ({ hidden: new Set<string>(), offline: new Set<string>() }));
    const items: SnapItem[] = [];
    let omitted = 0;
    for (const d of dirents) {
      const name = d.name.normalize('NFC');
      const abs = path.join(dir.abs, d.name);
      if (!checkFsName(name, 'reference').ok || this.resolver.blocked(abs)) {
        omitted++;
        continue;
      }
      const hidden = isFsHiddenName(name) || attrs.hidden.has(name);
      if (hidden && !req.includeHidden) continue;
      let type: 'file' | 'dir' | null = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
      if (d.isSymbolicLink() || (!type && !d.isFIFO() && !d.isSocket() && !d.isBlockDevice() && !d.isCharacterDevice())) {
        // Link (ou tipo desconhecido do sistema de arquivos): só aparece se o destino estiver dentro da raiz.
        type = await this.linkType(dir.rootReal, abs);
      }
      if (!type) {
        omitted++;
        continue;
      }
      items.push({ name, diskName: d.name, type, hidden });
    }
    const snap: Snapshot = {
      id: randomBytes(12).toString('base64url'),
      key,
      at: this.now(),
      dirAbs: dir.abs,
      items,
      omitted,
      offline: attrs.offline,
    };
    const sort = req.sort ?? 'name';
    const order = req.order ?? 'asc';
    if (sort === 'name') {
      // Ordem por nome não precisa de `stat` de tudo (pastas enormes): o `stat` é feito página a página.
      const light = (it: SnapItem): FsEntry => ({
        name: it.name,
        type: it.type,
        size: null,
        mtime: '',
        mime: null,
        hidden: false,
        hasThumb: false,
      });
      items.sort((a, b) => compareFsEntries(light(a), light(b), 'name', order));
    } else {
      await mapLimit(items, 32, async (it) => {
        it.entry = await this.statItem(snap, it);
      });
      const kept = items.filter((it) => it.entry);
      kept.sort((a, b) => compareFsEntries(a.entry!, b.entry!, sort, order));
      snap.items = kept;
    }
    this.snapshots.set(snap.id, snap);
    return snap;
  }

  private async linkType(rootReal: string, abs: string): Promise<'file' | 'dir' | null> {
    try {
      const real = await this.o.roots.realpath(abs);
      if (!this.resolver.allowed(rootReal, real)) return null;
      const st = await fsp.stat(real);
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch {
      return null;
    }
  }

  private async statItem(snap: Snapshot, it: SnapItem): Promise<FsEntry | null> {
    try {
      const st = await fsp.stat(path.join(snap.dirAbs, it.diskName));
      if (!st.isDirectory() && !st.isFile()) return null;
      return this.entryFor(it.name, st, { hidden: it.hidden, offline: snap.offline.has(it.name) });
    } catch {
      return null; // sumiu depois da listagem
    }
  }

  private pruneSnapshots(): void {
    const t = this.now();
    for (const [id, s] of this.snapshots) if (t - s.at > FS_LIST_SNAPSHOT_TTL_MS) this.snapshots.delete(id);
    while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  // =================================================================== stat / thumb

  async stat(req: FsStatRequest): Promise<FsStatResponse> {
    const it = await this.resolver.existing(req.rootId, req.path);
    return { rootId: req.rootId, path: req.path, entry: this.entryOf(it) };
  }

  /** Resolve e gera (ou pega do cache) a miniatura. A LAN devolve o JPEG; o remoto, base64 no envelope. */
  async thumbnail(req: FsThumbRequest): Promise<ThumbResult & { item: ResolvedItem }> {
    const it = await this.resolver.existing(req.rootId, req.path);
    if (it.stat.isDirectory()) throw new FsOpError('IS_A_DIRECTORY');
    const mime = fsMimeFromName(it.diskName.normalize('NFC'));
    if (!fsThumbCandidate(mime) || !this.o.platform.canThumbnail(mime)) throw new FsOpError('NO_THUMBNAIL');
    const t = await this.thumbs.get(it.abs, it.stat, req.size ?? FS_THUMB_DEFAULT_SIZE);
    return { ...t, item: it };
  }

  // =================================================================== mkdir / rename

  private async mkdir(req: FsMkdirRequest): Promise<FsMkdirResponse> {
    const { dir, abs } = await this.resolver.newChild(req.rootId, req.path, req.name);
    const rel = joinFsPath(req.path, req.name);
    const existing = await lstatOrNull(abs);
    if (existing) {
      const st = existing.isSymbolicLink() ? await fsp.stat(abs).catch(() => null) : existing;
      if (st?.isDirectory()) return { rootId: req.rootId, path: rel, entry: this.entryFor(req.name, st), created: false };
      throw new FsOpError('CONFLICT');
    }
    try {
      await fsp.mkdir(abs);
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') {
        const st = await fsp.stat(abs);
        if (st.isDirectory()) return { rootId: req.rootId, path: rel, entry: this.entryFor(req.name, st), created: false };
        throw new FsOpError('CONFLICT');
      }
      // Criar pasta não esbarra em "arquivo aberto": na raiz da unidade, `EPERM` é a permissão da raiz.
      throw driveRootWriteError(err, dir.abs, this.fsPlatform, DRIVE_ROOT_MKDIR_MESSAGE) ?? fsErrorFromErrno(err, 'write');
    }
    await fsyncDir(dir.abs, { logger: this.log });
    return { rootId: req.rootId, path: rel, entry: this.entryFor(req.name, await fsp.stat(abs)), created: true };
  }

  private async rename(req: FsRenameRequest): Promise<FsEntryResponse> {
    const it = await this.resolver.item(req.rootId, req.path);
    const parentRel = fsParentPath(req.path);
    const newRel = joinFsPath(parentRel, req.newName);
    const current = it.diskName.normalize('NFC');
    if (current === req.newName) return { rootId: req.rootId, path: newRel, entry: this.entryOf(it) };
    const parentAbs = path.dirname(it.abs);
    const dest = path.join(parentAbs, req.newName);
    if (!this.resolver.allowed(it.rootReal, dest)) throw new FsOpError('FORBIDDEN_PATH');
    const caseOnly = this.resolver.caseInsensitive && current.toLowerCase() === req.newName.toLowerCase();
    if (!caseOnly && (await lstatOrNull(dest))) throw new FsOpError('CONFLICT');
    try {
      await renameWithRetry(it.abs, dest, 3, 50);
    } catch (err) {
      // Arquivo na raiz de `C:\`: renomear exige gravar arquivo ali (administrador). Pasta segue a regra de sempre.
      throw (!it.stat.isDirectory() && driveRootWriteError(err, parentAbs, this.fsPlatform)) || fsErrorFromErrno(err, 'write');
    }
    await fsyncDir(parentAbs, { logger: this.log });
    const st = await fsp.stat(dest);
    return { rootId: req.rootId, path: newRel, entry: this.entryFor(req.newName, st) };
  }

  // =================================================================== move

  private async move(req: FsMoveRequest): Promise<FsBatchResponse> {
    const toRootId = req.toRootId ?? req.rootId;
    const policy = req.onConflict ?? 'fail';
    const destDir = await this.resolver.directory(toRootId, req.toPath);
    const touched = new Set<string>([destDir.abs]);
    const results: FsBatchItemResult[] = [];
    for (const p of req.paths) {
      try {
        const it = await this.resolver.item(req.rootId, p);
        const isRealDir = it.stat.isDirectory() && !it.isLink;
        if (isRealDir && isAbsPathInside(it.abs, destDir.abs, this.fsPlatform)) throw new FsOpError('INVALID_MOVE');
        const name = it.diskName;
        const parentAbs = path.dirname(it.abs);
        if (samePath(parentAbs, destDir.abs, this.resolver.caseInsensitive)) {
          // Já está no destino: nada muda.
          results.push({ path: p, ok: true, newPath: joinFsPath(req.toPath, name.normalize('NFC')) });
          continue;
        }
        let finalName = name;
        let dest = path.join(destDir.abs, finalName);
        if (await lstatOrNull(dest)) {
          if (policy === 'fail') throw new FsOpError('CONFLICT');
          if (policy === 'skip') {
            results.push({ path: p, ok: true, newPath: null, skipped: true });
            continue;
          }
          for (let n = 2; ; n++) {
            if (n > 9999) throw new FsOpError('CONFLICT');
            finalName = fsCollisionName(name, n, it.stat.isDirectory());
            dest = path.join(destDir.abs, finalName);
            if (!(await lstatOrNull(dest))) break;
          }
        }
        if (!this.resolver.allowed(destDir.rootReal, dest)) throw new FsOpError('FORBIDDEN_PATH');
        try {
          await renameWithRetry(it.abs, dest, 3, 50);
        } catch (err) {
          throw (!it.stat.isDirectory() && driveRootWriteError(err, destDir.abs, this.fsPlatform)) || fsErrorFromErrno(err, 'write');
        }
        touched.add(parentAbs);
        results.push({ path: p, ok: true, newPath: joinFsPath(req.toPath, finalName.normalize('NFC')) });
      } catch (err) {
        results.push({ path: p, ok: false, error: this.errorBody(err, 'move') });
      }
    }
    for (const d of touched) await fsyncDir(d, { logger: this.log });
    return { results };
  }

  // =================================================================== trash

  private async trash(req: FsTrashRequest): Promise<FsBatchResponse> {
    const results: FsBatchItemResult[] = [];
    for (const p of req.paths) {
      try {
        const it = await this.resolver.item(req.rootId, p);
        await this.trashAbs(it.abs);
        results.push({ path: p, ok: true, newPath: null });
      } catch (err) {
        results.push({ path: p, ok: false, error: this.errorBody(err, 'trash') });
      }
    }
    return { results };
  }

  /**
   * Manda um caminho absoluto (já resolvido e permitido) para a Lixeira. **Antes** confere se o volume tem
   * Lixeira (§10.11): sem Lixeira → `TRASH_UNAVAILABLE` e nada é apagado. Nunca apaga em definitivo.
   */
  async trashAbs(abs: string): Promise<void> {
    const vol = await this.o.volumes.info(path.dirname(abs)).catch(() => null);
    if (!vol?.trashAvailable) throw new FsOpError('TRASH_UNAVAILABLE');
    try {
      await this.o.platform.trashItem(abs);
    } catch (err) {
      if (err instanceof FsOpError) throw err;
      if (errnoCode(err)) throw fsErrorFromErrno(err, 'write');
      const msg = err instanceof Error ? err.message : String(err);
      if (/in use|being used|sharing violation|busy|ebusy|locked/i.test(msg))
        throw new FsOpError('BUSY', 'Feche o arquivo no PC e tente de novo.');
      if (!(await lstatOrNull(abs))) throw new FsOpError('NOT_FOUND');
      if (/denied|permission|access/i.test(msg)) throw new FsOpError('PERMISSION_DENIED');
      this.log.warn('Lixeira: falha ao mover item', msg);
      throw new FsOpError('INTERNAL');
    }
  }
}

export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (it: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/** Resultado de erro pronto (para quem precisa responder sem passar pelo despachante). */
export function fsErrorResult(body: FsErrorBody | FsOpError): FsRpcResult {
  return { ok: false, error: body instanceof FsOpError ? body.body : body };
}
