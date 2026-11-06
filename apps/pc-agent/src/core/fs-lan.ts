// Pastas liberadas: rotas `/v1/fs/*` do servidor LAN (contrato §10.5). Assinatura própria (nonce, query e
// corpo assinados), mesmo despachante do remoto (`FsService`), download com Range e envio em pedaços.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import type http from 'node:http';
import {
  FS_ERROR_STATUS,
  FS_LAN_JSON_MAX_BYTES,
  FS_LAN_ROUTES,
  FS_UPLOAD_NAME_CONFLICT_STATUS,
  LAN_HEADERS,
  canonicalFsQuery,
  fsEncodeComponent,
  fsError,
  parseFsQuery,
  parseFsRequest,
  type FsErrorBody,
  type FsErrorCode,
  type FsOp,
  type FsRequest,
} from '@arkivo/shared';
import { FsOpError } from './fs-errors';
import { NonceCache, verifyLanFsRequest } from './fs-lan-auth';
import { FsUploadError, LanUploads, parseUploadQuery } from './fs-lan-upload';
import type { FsCallContext, FsService } from './fs-service';
import type { LanAuthContext } from './lan-auth';
import { CORS_HEADERS, parseChunkRange, sendJson } from './lan-http';
import { Clock, Logger, silentLogger } from './types';

const HEX64 = /^[0-9a-f]{64}$/;
const UPLOAD_ROUTE = /^\/v1\/fs\/upload\/([^/]+)$/;
const JSON_ROUTES: Record<string, FsOp> = {
  '/v1/fs/mkdir': 'mkdir',
  '/v1/fs/rename': 'rename',
  '/v1/fs/move': 'move',
  '/v1/fs/trash': 'trash',
  [FS_LAN_ROUTES.outboxDone]: 'outboxDone',
  [FS_LAN_ROUTES.outboxDecline]: 'outboxDecline',
};
const GET_ROUTES: Record<string, FsOp> = {
  '/v1/fs/roots': 'roots',
  '/v1/fs/list': 'list',
  '/v1/fs/stat': 'stat',
  [FS_LAN_ROUTES.outbox]: 'outboxList',
};

/** O que `sendFile` manda: já resolvido e conferido por quem chama. */
interface LanFile {
  abs: string;
  stat: Stats;
  name: string;
  mime: string | null;
}

interface LanFileHooks {
  /** O download começou (não chamado em `HEAD` nem em retomada). */
  onStart?: (size: number) => void;
  /** Posição no arquivo até onde já foi enviado. */
  onSent?: (position: number) => void;
}

export interface FsLanRequestInfo {
  method: string;
  pathname: string;
  rawQuery: string;
  auth: LanAuthContext | null;
}

export interface FsLanRoutesOptions {
  service: FsService;
  minFreeMarginBytes?: number;
  freeBytes?: (dir: string) => Promise<number>;
  now?: Clock;
  logger?: Logger;
}

class LanFsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: FsErrorBody,
    readonly headers: Record<string, string> = {},
  ) {
    super(body.message);
  }
}

const err = (code: FsErrorCode, message?: string, status?: number, headers?: Record<string, string>) =>
  new LanFsHttpError(status ?? FS_ERROR_STATUS[code], fsError(code, message), headers);

/** Status HTTP de uma resposta de erro do despachante. */
function statusOf(body: FsErrorBody): number {
  return FS_ERROR_STATUS[body.code] ?? 500;
}

export class FsLanRoutes {
  readonly uploads: LanUploads;
  private readonly nonces = new NonceCache();
  private readonly now: Clock;
  private readonly log: Logger;

  constructor(private readonly o: FsLanRoutesOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.logger ?? silentLogger;
    this.uploads = new LanUploads({
      service: o.service,
      minFreeMarginBytes: o.minFreeMarginBytes,
      freeBytes: o.freeBytes,
      now: this.now,
      logger: this.log,
    });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, info: FsLanRequestInfo): Promise<void> {
    try {
      await this.route(req, res, info);
    } catch (e) {
      const he = this.toHttpError(e, info);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!req.complete) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      sendJson(res, he.status, { error: he.body }, he.headers);
    }
  }

  private toHttpError(e: unknown, info: FsLanRequestInfo): LanFsHttpError {
    if (e instanceof LanFsHttpError) return e;
    if (e instanceof FsUploadError) {
      const status = e.status ?? (e.code === 'CONFLICT' ? FS_UPLOAD_NAME_CONFLICT_STATUS : FS_ERROR_STATUS[e.code]);
      return new LanFsHttpError(status, e.body, e.headers);
    }
    if (e instanceof FsOpError) {
      // No PUT de envio, conflito de nome é 412: 409 ali significa só "hash diferente" (§4.1, §10.3).
      const isUploadPut = info.method === 'PUT' && UPLOAD_ROUTE.test(info.pathname);
      const status = isUploadPut && e.code === 'CONFLICT' ? FS_UPLOAD_NAME_CONFLICT_STATUS : FS_ERROR_STATUS[e.code];
      return new LanFsHttpError(status, e.body);
    }
    this.log.error('Pastas liberadas (LAN): erro inesperado', e);
    return err('INTERNAL');
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, info: FsLanRequestInfo): Promise<void> {
    const { method, pathname } = info;
    const query = parseFsQuery(info.rawQuery);
    if (!query) throw err('VALIDATION_ERROR', 'Query inválida (chave repetida ou codificação errada).');
    const uploadMatch = UPLOAD_ROUTE.exec(pathname);
    const jsonOp = JSON_ROUTES[pathname];
    const getOp = GET_ROUTES[pathname];
    const known = uploadMatch || jsonOp || getOp || pathname === '/v1/fs/thumb' || pathname === '/v1/fs/download' || pathname === FS_LAN_ROUTES.outboxDownload;
    if (!known) throw err('NOT_FOUND', 'Rota não encontrada');

    // Corpo assinado: POST = SHA-256 dos bytes; PUT de envio = X-Arkivo-Hash; demais = vazio.
    let body: Buffer | null = null;
    let bodySha = '';
    if (method === 'POST' && jsonOp) {
      body = await readBody(req, FS_LAN_JSON_MAX_BYTES);
      bodySha = createHash('sha256').update(body).digest('hex');
    } else if (method === 'PUT' && uploadMatch) {
      bodySha = String(req.headers[LAN_HEADERS.hash] ?? '').toLowerCase();
      if (!HEX64.test(bodySha)) throw err('VALIDATION_ERROR', 'X-Arkivo-Hash ausente ou inválido');
    }
    const auth = verifyLanFsRequest(
      { method, path: pathname, query: canonicalFsQuery(query), headers: req.headers, bodySha256: bodySha, now: this.now() },
      info.auth,
      this.nonces,
    );
    if (!auth.ok) throw err(auth.code, auth.message, auth.status);
    const ctx: FsCallContext = { phoneId: auth.phoneId, via: 'lan' };

    if (getOp) {
      if (method !== 'GET') throw err('VALIDATION_ERROR', 'Método não suportado', 405);
      return this.json(res, ctx, { ...query, op: getOp });
    }
    if (jsonOp) {
      if (method !== 'POST') throw err('VALIDATION_ERROR', 'Método não suportado', 405);
      const ct = String(req.headers['content-type'] ?? '');
      if (ct && !/^application\/json\b/i.test(ct)) throw err('VALIDATION_ERROR', 'Content-Type: application/json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body!.toString('utf8'));
      } catch {
        throw err('VALIDATION_ERROR', 'JSON inválido');
      }
      if (!parsed || typeof parsed !== 'object' || (parsed as { op?: unknown }).op !== jsonOp)
        throw err('VALIDATION_ERROR', `op deve ser "${jsonOp}"`);
      return this.json(res, ctx, parsed);
    }
    if (pathname === '/v1/fs/thumb') {
      if (method !== 'GET') throw err('VALIDATION_ERROR', 'Método não suportado', 405);
      return this.thumb(req, res, ctx, query);
    }
    if (pathname === '/v1/fs/download') {
      if (method !== 'GET' && method !== 'HEAD') throw err('VALIDATION_ERROR', 'Método não suportado', 405);
      return this.download(req, res, ctx, query, method === 'HEAD');
    }
    if (pathname === FS_LAN_ROUTES.outboxDownload) {
      if (method !== 'GET' && method !== 'HEAD') throw err('VALIDATION_ERROR', 'Método não suportado', 405);
      return this.outboxDownload(req, res, ctx, query, method === 'HEAD');
    }
    // upload
    let uploadId: string;
    try {
      uploadId = decodeURIComponent(uploadMatch![1]);
    } catch {
      throw err('VALIDATION_ERROR', 'uploadId: inválido.');
    }
    return this.upload(req, res, ctx, method, uploadId, query);
  }

  private parse(input: unknown): FsRequest {
    const p = parseFsRequest(input);
    if (!p.ok) throw new LanFsHttpError(statusOf(p.error), p.error);
    return p.request;
  }

  private async json(res: http.ServerResponse, ctx: FsCallContext, input: unknown): Promise<void> {
    const r = await this.o.service.execute(ctx, this.parse(input));
    if (r.ok) sendJson(res, 200, r.data);
    else sendJson(res, statusOf(r.error), { error: r.error });
  }

  private async thumb(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: FsCallContext,
    query: Record<string, string>,
  ): Promise<void> {
    const r = this.parse({ ...query, op: 'thumb' });
    if (r.op !== 'thumb') throw err('VALIDATION_ERROR');
    const svc = this.o.service;
    svc.gate(ctx, 'thumb');
    svc.browseFrom(ctx);
    const t = await svc.thumbnail(r);
    const headers = { ...CORS_HEADERS, ETag: t.etag, 'Cache-Control': 'private, max-age=300' };
    const inm = req.headers['if-none-match'];
    if (
      inm &&
      String(inm)
        .split(/\s*,\s*/)
        .includes(t.etag)
    ) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg', 'Content-Length': String(t.jpeg.length) }).end(t.jpeg);
  }

  private async download(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: FsCallContext,
    query: Record<string, string>,
    head: boolean,
  ): Promise<void> {
    const r = this.parse({ ...query, op: 'download' });
    if (r.op !== 'download') throw err('VALIDATION_ERROR');
    const svc = this.o.service;
    svc.gate(ctx, 'stat');
    const it = await svc.resolver.existing(r.rootId, r.path);
    if (it.stat.isDirectory()) throw err('IS_A_DIRECTORY');
    if (!it.stat.isFile()) throw err('NOT_FOUND');
    const entry = svc.entryOf(it);
    return this.sendFile(req, res, ctx, { abs: it.abs, stat: it.stat, name: entry.name, mime: entry.mime }, head, {
      onStart: (size) =>
        svc.audit({
          phoneId: ctx.phoneId,
          phoneName: svc.phoneName(ctx.phoneId),
          via: 'lan',
          op: 'download',
          rootId: r.rootId,
          rootLabel: it.root.label,
          path: r.path,
          toPath: null,
          count: 1,
          bytes: size,
          result: 'ok',
        }),
    });
  }

  /**
   * §11: `GET`/`HEAD /v1/fs/outbox/download?id=`. Só leva o `id`: o arquivo é o que o usuário escolheu para este
   * celular, conferido de novo a cada pedaço. Independe do interruptor "Acesso pelo celular".
   */
  private async outboxDownload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: FsCallContext,
    query: Record<string, string>,
    head: boolean,
  ): Promise<void> {
    const r = this.parse({ ...query, op: 'outboxDownload' });
    if (r.op !== 'outboxDownload') throw err('VALIDATION_ERROR');
    const svc = this.o.service;
    const outbox = svc.outbox;
    if (!outbox) throw err('UNSUPPORTED_OP');
    // Cada pedaço com `Range` é um pedido novo: usa a cota de leitura, como `download`.
    svc.gate(ctx, 'outboxList');
    const file = head ? await outbox.inspect(ctx.phoneId, r.id) : await outbox.beginDelivery(ctx.phoneId, r.id, 'lan');
    return this.sendFile(req, res, ctx, { abs: file.abs, stat: file.stat, name: file.name, mime: file.mime }, head, {
      onStart: (size) => svc.auditOutbox(ctx, 'outboxDownload', file.name, size),
      onSent: (position) => outbox.progress(file.id, position),
    });
  }

  private async sendFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: FsCallContext,
    file: LanFile,
    head: boolean,
    hooks: LanFileHooks,
  ): Promise<void> {
    const svc = this.o.service;
    const size = file.stat.size;
    const etag = `"${size}-${Math.floor(file.stat.mtimeMs)}"`;
    const base: Record<string, string> = {
      ...CORS_HEADERS,
      'Content-Type': file.mime ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': new Date(file.stat.mtimeMs).toUTCString(),
      'Content-Disposition': `attachment; filename*=UTF-8''${fsEncodeComponent(file.name)}`,
      'Cache-Control': 'no-store',
    };
    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (range && (!ifRange || ifRange === etag)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      let ok = !!m && (m[1] !== '' || m[2] !== '');
      if (ok && m) {
        if (m[1] === '') {
          const n = Number(m[2]);
          start = Math.max(0, size - n);
          ok = n > 0;
        } else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
          ok = start < size && start <= end;
        }
      }
      if (!ok) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }).end();
        return;
      }
      partial = true;
    }
    const length = size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = { ...base, 'Content-Length': String(length) };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (head) {
      res.writeHead(partial ? 206 : 200, headers).end();
      return;
    }
    const release = svc.lanDownloads.acquire(ctx.phoneId);
    if (!release) throw err('RATE_LIMITED', 'Muitos downloads ao mesmo tempo. Espere um terminar.');
    if (start === 0) hooks.onStart?.(size);
    res.on('close', release);
    res.writeHead(partial ? 206 : 200, headers);
    if (length === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file.abs, { start, end });
    stream.on('error', (e) => {
      this.log.warn('Download LAN interrompido', e.message);
      res.destroy();
    });
    if (hooks.onSent) {
      let position = start;
      stream.on('data', (c) => {
        position += c.length;
        hooks.onSent?.(position);
      });
    }
    stream.pipe(res);
  }

  private async upload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: FsCallContext,
    method: string,
    uploadId: string,
    query: Record<string, string>,
  ): Promise<void> {
    const svc = this.o.service;
    if (method === 'DELETE') {
      svc.gate(ctx, 'mkdir');
      if (!query.rootId) throw err('VALIDATION_ERROR', 'rootId: obrigatório.');
      await this.uploads.cancel(query.rootId, uploadId);
      res.writeHead(204, CORS_HEADERS).end();
      return;
    }
    const q = parseUploadQuery(uploadId, query);
    if (method === 'HEAD') {
      svc.gate(ctx, 'stat');
      const received = await this.uploads.head(ctx, uploadId, q);
      res.writeHead(200, { ...CORS_HEADERS, 'X-Arkivo-Received': String(received), 'Content-Length': '0' }).end();
      return;
    }
    if (method !== 'PUT') throw err('VALIDATION_ERROR', 'Método não suportado', 405);
    const range = parseChunkRange(req.headers);
    if (!range.ok) throw err('VALIDATION_ERROR', range.message, range.status);
    // Só o começo do envio conta como mudança (5/s): a 5 pedaços de 8 MiB por segundo, contar todos seguraria o
    // envio em 40 MiB/s. Os pedaços seguintes usam a cota de leitura.
    svc.gate(ctx, range.range.start === 0 ? 'upload' : 'stat');
    const hash = String(req.headers[LAN_HEADERS.hash]).toLowerCase();
    const reply = await this.uploads.put(ctx, uploadId, q, hash, range.range, req);
    if (reply.dropped) {
      res.destroy();
      return;
    }
    sendJson(res, reply.status, reply.body ?? {}, reply.headers);
  }

  /** Limpeza de envios abandonados (partida do PC). */
  cleanup(): Promise<void> {
    return this.uploads.cleanup();
  }
}

/** Lê o corpo JSON com limite (acima → 413). */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > max) return Promise.reject(err('TOO_LARGE', 'Corpo acima de 64 KiB.', 413));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      n += c.length;
      if (n > max) {
        failed = true;
        reject(err('TOO_LARGE', 'Corpo acima de 64 KiB.', 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) reject(e);
    });
  });
}
