// Pastas liberadas: envio do celular pela LAN em pedaços com retomada (contrato §10.5 + §4.1).
// `.part` em `<raiz>/.arkivo-fs-parciais/<uploadId>.part` com `<uploadId>.json` ao lado; mesma disciplina de
// durabilidade do backup: cada pedaço aceito passa por fsync, o SHA-256 é conferido relendo o arquivo
// sincronizado e só então vem o `rename` atômico e o fsync dos diretórios.
import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { FS_CLIENT_ID_RE, FS_PARTS_DIR_NAME, chunkStartDecision, parseFsRequest, type FsUploadResult } from '@arkivo/shared';
import { FsOpError } from './fs-errors';
import { ensurePartsDir, placeUpload, precheckUpload, removePartsDirIfEmpty, type UploadPolicy } from './fs-place';
import type { FsCallContext, FsService } from './fs-service';
import { DiskError, isNoSpace, readJson, writeFileAtomic, writeStreamDurable } from './fs-utils';
import { bodyGuard, type ChunkRange } from './lan-http';
import { ONE_GIB } from './lan-server';
import { freeBytes as freeBytesOf } from './net-info';
import { sha256File } from './storage';
import { Logger, silentLogger } from './types';

/** `.part` parado há mais disso é apagado na partida do PC (§10.5). */
export const FS_LAN_PART_MAX_AGE_MS = 7 * 24 * 3600_000;
/** O PC lembra os envios concluídos por 24 h (último pedaço repetido → mesmo resultado). */
export const FS_LAN_DONE_TTL_MS = 24 * 3600_000;

export interface LanUploadQuery {
  rootId: string;
  path: string;
  name: string;
  onConflict: UploadPolicy;
}

interface UploadMeta extends LanUploadQuery {
  v: 1;
  uploadId: string;
  hash: string;
  size: number;
  phoneId: string;
  createdAt: string;
  done?: FsUploadResult;
  doneAt?: string;
}

/** Resposta pronta para o servidor LAN escrever. */
export interface UploadReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Conexão caiu no meio: o servidor só destrói a resposta. */
  dropped?: boolean;
}

export class FsUploadError extends FsOpError {
  constructor(
    code: ConstructorParameters<typeof FsOpError>[0],
    message?: string,
    readonly status?: number,
    readonly headers: Record<string, string> = {},
  ) {
    super(code, message);
  }
}

/** Valida a query do envio com as mesmas regras do shared (caminho, nome de criação, `rootId`). */
export function parseUploadQuery(uploadId: string, q: Record<string, string>): LanUploadQuery {
  if (!FS_CLIENT_ID_RE.test(uploadId)) throw new FsOpError('VALIDATION_ERROR', 'uploadId: inválido.');
  const parsed = parseFsRequest({ op: 'mkdir', requestId: uploadId, rootId: q.rootId, path: q.path ?? '', name: q.name });
  if (!parsed.ok) throw new FsOpError(parsed.error.code, parsed.error.message);
  const pol = q.onConflict ?? 'rename';
  if (pol !== 'rename' && pol !== 'replace' && pol !== 'fail')
    throw new FsOpError('VALIDATION_ERROR', 'onConflict: use rename, replace ou fail.');
  const r = parsed.request as { rootId: string; path: string; name: string };
  return { rootId: r.rootId, path: r.path, name: r.name, onConflict: pol };
}

export interface LanUploadsOptions {
  service: FsService;
  minFreeMarginBytes?: number;
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => number;
  logger?: Logger;
}

export class LanUploads {
  private readonly busy = new Set<string>();
  private readonly margin: number;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly o: LanUploadsOptions) {
    this.margin = o.minFreeMarginBytes ?? ONE_GIB;
    this.log = o.logger ?? silentLogger;
    this.now = o.now ?? Date.now;
  }

  private files(rootReal: string, uploadId: string) {
    const dir = path.join(rootReal, FS_PARTS_DIR_NAME);
    return { dir, part: path.join(dir, `${uploadId}.part`), meta: path.join(dir, `${uploadId}.json`) };
  }

  private async loadMeta(file: string): Promise<UploadMeta | null> {
    const m = await readJson<UploadMeta>(file).catch(() => null);
    return m && m.v === 1 ? m : null;
  }

  private sameQuery(m: UploadMeta, q: LanUploadQuery, ctx: FsCallContext): void {
    if (m.rootId !== q.rootId || m.path !== q.path || m.name !== q.name || m.onConflict !== q.onConflict) {
      throw new FsOpError('VALIDATION_ERROR', 'Este envio foi começado com outros parâmetros.');
    }
    if (m.phoneId !== ctx.phoneId) throw new FsOpError('VALIDATION_ERROR', 'Este envio é de outro celular.');
  }

  /** `HEAD`: quanto já chegou (concluído = o tamanho todo; o celular reenvia o último pedaço e recebe o resultado). */
  async head(ctx: FsCallContext, uploadId: string, q: LanUploadQuery): Promise<number> {
    const dir = await this.o.service.resolver.directory(q.rootId, q.path);
    const f = this.files(dir.rootReal, uploadId);
    const meta = await this.loadMeta(f.meta);
    if (!meta) return 0;
    this.sameQuery(meta, q, ctx);
    if (meta.done) return meta.size;
    return partSize(f.part);
  }

  async cancel(rootId: string, uploadId: string): Promise<void> {
    if (!FS_CLIENT_ID_RE.test(uploadId)) throw new FsOpError('VALIDATION_ERROR', 'uploadId: inválido.');
    if (this.busy.has(uploadId)) throw new FsOpError('BUSY', 'Este envio ainda está chegando.');
    const r = await this.o.service.resolver.root(rootId);
    const f = this.files(r.real, uploadId);
    await fsp.rm(f.part, { force: true });
    await fsp.rm(f.meta, { force: true });
    await removePartsDirIfEmpty(r.real);
  }

  async put(
    ctx: FsCallContext,
    uploadId: string,
    q: LanUploadQuery,
    hash: string,
    range: ChunkRange,
    req: http.IncomingMessage,
  ): Promise<UploadReply> {
    const svc = this.o.service;
    if (this.busy.has(uploadId)) throw new FsUploadError('BUSY', 'Este arquivo já está sendo recebido.');
    this.busy.add(uploadId);
    try {
      const dir = await svc.resolver.directory(q.rootId, q.path);
      const f = this.files(dir.rootReal, uploadId);
      let meta = await this.loadMeta(f.meta);
      if (meta) {
        this.sameQuery(meta, q, ctx);
        if (meta.hash !== hash) throw new FsOpError('VALIDATION_ERROR', 'X-Arkivo-Hash diferente do começo do envio.');
        if (meta.size !== range.total) throw new FsOpError('VALIDATION_ERROR', 'Tamanho diferente do começo do envio.');
        if (meta.done) {
          req.resume();
          return { status: 200, body: meta.done };
        }
      }
      const have = meta ? await partSize(f.part) : 0;
      const decision = chunkStartDecision(range.start, have);
      if (decision === 'gap')
        throw new FsUploadError('VALIDATION_ERROR', 'Faltam bytes antes deste pedaço', 416, { 'X-Arkivo-Received': String(have) });
      if (!meta) {
        // Primeiro pedaço: confere o nome antes de receber o arquivo inteiro (§10.5: "no primeiro pedaço e no final").
        await precheckUpload(svc, q.rootId, q.path, q.name, q.onConflict);
      }
      const free = await (this.o.freeBytes ?? freeBytesOf)(dir.rootReal);
      if (free < range.total - range.start + this.margin)
        throw new FsUploadError('NO_SPACE', 'Pouco espaço livre no PC para receber este arquivo.', 507);
      await ensurePartsDir(dir.rootReal);
      if (!meta) {
        meta = { v: 1, uploadId, ...q, hash, size: range.total, phoneId: ctx.phoneId, createdAt: new Date(this.now()).toISOString() };
        await writeFileAtomic(f.meta, JSON.stringify(meta), 0o600);
      }
      if (decision === 'rewrite' || !(await exists(f.part))) {
        await fsp.truncate(f.part, range.start).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') await fsp.writeFile(f.part, '');
          else throw e;
        });
      }

      const limit = range.expectedEnd - range.start;
      let written = 0;
      const counter = new Transform({
        transform: (chunk: Buffer, _e, cb) => {
          written += chunk.length;
          if (written > limit) return cb(new FsUploadError('VALIDATION_ERROR', 'Corpo maior que o anunciado'));
          cb(null, chunk);
        },
      });
      try {
        await writeStreamDurable(f.part, [bodyGuard(req), counter], { flags: 'a' });
      } catch (err) {
        if (err instanceof FsOpError) throw err;
        if (err instanceof DiskError) throw await this.diskFailure(f.part, range.start, err);
        this.log.warn(`Envio LAN (pastas) interrompido (${uploadId}) em ${range.start + written} bytes`);
        return { status: 0, dropped: true };
      }
      const received = range.start + written;
      if (received < range.expectedEnd)
        throw new FsUploadError('VALIDATION_ERROR', 'Pedaço incompleto', 400, { 'X-Arkivo-Received': String(received) });
      if (received < range.total) return { status: 202, body: { received }, headers: { 'X-Arkivo-Received': String(received) } };

      // Completo, com fsync e fechado: confere o SHA-256 relendo o que foi gravado.
      const actual = await sha256File(f.part);
      if (actual !== hash) {
        await fsp.rm(f.part, { force: true });
        await fsp.rm(f.meta, { force: true });
        throw new FsUploadError('HASH_MISMATCH', undefined, 409, { 'X-Arkivo-Received': '0' });
      }
      let result: FsUploadResult;
      try {
        result = await placeUpload(svc, {
          rootId: q.rootId,
          dirRel: q.path,
          name: q.name,
          policy: q.onConflict,
          partPath: f.part,
          hash: actual,
        });
      } catch (err) {
        if (err instanceof FsOpError && (err.code === 'CONFLICT' || err.code === 'ROOT_REMOVED' || err.code === 'FORBIDDEN_PATH')) {
          // Não vai mais dar para concluir: não deixa o `.part` para trás.
          await fsp.rm(f.part, { force: true });
          await fsp.rm(f.meta, { force: true });
        }
        if (isNoSpace(err))
          throw new FsUploadError('NO_SPACE', 'O disco do PC encheu ao guardar o arquivo.', 507, {
            'X-Arkivo-Received': String(await partSize(f.part)),
          });
        throw err;
      }
      meta = { ...meta, done: result, doneAt: new Date(this.now()).toISOString() };
      await writeFileAtomic(f.meta, JSON.stringify(meta), 0o600).catch(() => undefined);
      const label = svc.roots.get(q.rootId)?.label ?? null;
      svc.audit({
        phoneId: ctx.phoneId,
        phoneName: svc.phoneName(ctx.phoneId),
        via: 'lan',
        op: 'upload',
        rootId: q.rootId,
        rootLabel: label,
        path: result.path,
        toPath: null,
        count: 1,
        bytes: range.total,
        result: 'ok',
      });
      return { status: 200, body: result };
    } finally {
      this.busy.delete(uploadId);
    }
  }

  /** Mesma regra do backup (§6): escrita que falhou volta o `.part` para `start`; fsync que falhou apaga. */
  private async diskFailure(part: string, start: number, err: DiskError): Promise<FsUploadError> {
    let received = 0;
    if ((err.phase === 'open' || err.phase === 'write') && start > 0) {
      try {
        await fsp.truncate(part, start);
        received = start;
      } catch {
        received = 0;
      }
    }
    if (received === 0) await fsp.rm(part, { force: true }).catch(() => undefined);
    const headers = { 'X-Arkivo-Received': String(received) };
    return isNoSpace(err)
      ? new FsUploadError('NO_SPACE', 'O disco do PC encheu durante o recebimento.', 507, headers)
      : new FsUploadError('INTERNAL', 'Erro ao gravar no disco do PC.', 500, headers);
  }

  /**
   * Na partida (§10.5): apaga `.part` parados há 7 dias, registros de concluídos com mais de 24 h e a pasta de
   * parciais que ficar vazia. Também limpa os `blob-*.part` de envios remotos abandonados.
   */
  async cleanup(): Promise<void> {
    const t = this.now();
    for (const root of this.o.service.roots.roots) {
      const dir = path.join(root.absPath, FS_PARTS_DIR_NAME);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const p = path.join(dir, n);
        const st = await fsp.stat(p).catch(() => null);
        if (!st?.isFile()) continue;
        if (n.endsWith('.part') && t - st.mtimeMs > FS_LAN_PART_MAX_AGE_MS) {
          await fsp.rm(p, { force: true });
          await fsp.rm(p.replace(/\.part$/, '.json'), { force: true });
        } else if (n.endsWith('.json')) {
          const m = await this.loadMeta(p);
          const doneOld = m?.doneAt && t - Date.parse(m.doneAt) > FS_LAN_DONE_TTL_MS;
          const orphanOld = !m?.done && t - st.mtimeMs > FS_LAN_PART_MAX_AGE_MS && !(await exists(p.replace(/\.json$/, '.part')));
          if (!m || doneOld || orphanOld) await fsp.rm(p, { force: true });
        }
      }
      await removePartsDirIfEmpty(root.absPath);
    }
  }
}

async function partSize(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

async function exists(p: string): Promise<boolean> {
  return fsp.stat(p).then(
    () => true,
    () => false,
  );
}
