import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Transform } from 'node:stream';
import {
  CAPABILITIES,
  FileKind,
  LAN_HEADERS,
  LanPingResponse,
  LanUploadResult,
  LocationReport,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  UPGRADE_REQUIRED_STATUS,
  UPLOAD_STATUS,
  checkClientCompat,
  chunkStartDecision,
  upgradeMessage,
} from '@arkivo/shared';
import { DiskError, isNoSpace } from './fs-utils';
import type { FsLanRoutes } from './fs-lan';
import { LanAuthContext, verifyLanRequest } from './lan-auth';
import { bodyGuard, CORS_HEADERS, headerValue } from './lan-http';
import { PlaceResult, Storage } from './storage';
import { Clock, Logger, silentLogger } from './types';

export const ONE_GIB = 1024 ** 3;

export interface LanServerContext extends LanAuthContext {
  /** ID do PC (devolvido no `/v1/ping`). */
  deviceId: string;
}

export interface LanServerOptions {
  port: number;
  host?: string;
  version: string;
  getContext: () => LanServerContext | null;
  storage: Storage;
  /** `POST /v1/files/:id/locations`. Erros são responsabilidade de quem injeta (fila de reenvio). */
  reportLocation: (fileId: string, report: LocationReport) => Promise<void>;
  /** Folga exigida além do tamanho restante (padrão 1 GiB, §6). */
  minFreeMarginBytes?: number;
  freeBytes?: () => Promise<number>;
  /** Rotas `/v1/fs/*` das pastas liberadas (§10.5). Ausente = a build não anuncia `fs` no ping. */
  fs?: FsLanRoutes | null;
  now?: Clock;
  logger?: Logger;
}

export interface LanUploadEvent {
  fileId: string;
  name: string;
  kind: FileKind | null;
  takenAt: string | null;
  received: number;
  total: number;
}

export interface LanCompletedEvent {
  fileId: string;
  name: string;
  relativePath: string;
  size: number;
  hash: string;
  alreadyExisted: boolean;
  phoneId: string;
}

/**
 * Eventos emitidos:
 * - `progress` (LanUploadEvent), `verifying` (LanUploadEvent), `completed` (LanCompletedEvent),
 * - `failed` ({ fileId, name, reason }), `seen` ({ phoneId }) — requisição autenticada de um celular.
 */

const FILE_ROUTE = /^\/v1\/files\/([^/?#]+)(\/thumbnail)?$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS: FileKind[] = ['photo', 'video', 'document'];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    /** Campos extras dentro de `error` (ex.: `minVersion`, `kind`, `protocol` no 426). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Servidor HTTP da LAN (§6). Só aceita celulares do mesmo usuário, com HMAC válido. */
export class LanServer extends EventEmitter {
  private server: http.Server | null = null;
  private readonly busy = new Set<string>();
  private readonly log: Logger;
  private readonly now: Clock;
  private readonly margin: number;

  constructor(private readonly opts: LanServerOptions) {
    super();
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.margin = opts.minFreeMarginBytes ?? ONE_GIB;
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? (a as AddressInfo).port : null;
  }

  get activeUploads(): number {
    return this.busy.size;
  }

  /** Inicia o servidor. Retorna a porta real (útil com porta 0 nos testes). */
  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.port ?? this.opts.port);
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.error('Erro no servidor LAN', err);
        if (!res.headersSent) this.sendError(res, new HttpError(500, 'INTERNAL', 'Erro interno no PC'));
        else res.destroy();
      });
    });
    server.requestTimeout = 0; // uploads grandes
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 10_000;
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        server.off('error', onError);
        server.on('error', (err) => this.log.error('Servidor LAN', err));
        resolve(this.port!);
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  // ------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawPath = req.url ?? '/';
    const pathname = rawPath.split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      const h: Record<string, string> = { ...CORS_HEADERS };
      // Private Network Access (Chrome/WebView): libera chamadas de páginas para IPs da LAN.
      if (req.headers['access-control-request-private-network']) h['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, h).end();
      return;
    }

    try {
      if (pathname === '/v1/ping' && (method === 'GET' || method === 'HEAD')) {
        const ctx = this.opts.getContext();
        // Sempre 200, mesmo para celular incompatível: é por aqui que ele descobre o `protocol` (§9) e vai para o relay.
        const body: LanPingResponse = {
          app: 'arkivo-pc',
          deviceId: ctx?.deviceId ?? '',
          version: this.opts.version,
          protocol: PROTOCOL_VERSION,
          minProtocol: MIN_PROTOCOL_VERSION,
        };
        // §10.5: `fs` sempre que a build tem o recurso, mesmo com o interruptor desligado (o estado vem de `roots`).
        if (this.opts.fs) body.capabilities = [CAPABILITIES.fs, CAPABILITIES.fsPush];
        this.sendJson(res, 200, body);
        return;
      }

      // §9: protocolo do celular antes da assinatura (o formato da assinatura pode mudar entre protocolos).
      // Sem cabeçalho → aceita (protocolo 1). O PC não tem versão mínima de celular: só confere o protocolo.
      const compat = checkClientCompat({ client: headerValue(req.headers, LAN_HEADERS.client), protocol: headerValue(req.headers, LAN_HEADERS.protocol) });
      if (compat.status === 'invalid') throw new HttpError(400, 'VALIDATION_ERROR', compat.message);
      if (compat.status === 'upgrade') {
        this.log.warn(`Celular com protocolo incompatível (${compat.protocol ?? '?'}); este PC fala ${PROTOCOL_VERSION}`);
        const info = { ...compat.info, kind: compat.info.kind ?? ('mobile' as const) };
        throw new HttpError(UPGRADE_REQUIRED_STATUS, 'UPGRADE_REQUIRED', upgradeMessage(info, compat.reason), {}, info);
      }

      if (this.opts.fs && pathname.startsWith('/v1/fs/')) {
        const q = rawPath.indexOf('?');
        await this.opts.fs.handle(req, res, { method, pathname, rawQuery: q < 0 ? '' : rawPath.slice(q + 1), auth: this.opts.getContext() });
        return;
      }

      const m = FILE_ROUTE.exec(pathname);
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'Rota não encontrada');
      let fileId: string;
      try {
        fileId = decodeURIComponent(m[1]);
      } catch {
        throw new HttpError(400, 'VALIDATION_ERROR', 'ID de arquivo inválido');
      }

      // §3.3: PATH assinado = só o caminho, como veio na linha de requisição, sem a query.
      const auth = verifyLanRequest({ method, path: pathname, headers: req.headers, now: this.now() }, this.opts.getContext());
      if (!auth.ok) throw new HttpError(auth.status, auth.code, auth.message);
      this.emit('seen', { phoneId: auth.phoneId });

      if (!FILE_ID.test(fileId)) throw new HttpError(400, 'VALIDATION_ERROR', 'ID de arquivo inválido');
      if (m[2]) {
        if (method !== 'GET') throw new HttpError(405, 'VALIDATION_ERROR', 'Método não suportado');
        throw new HttpError(404, 'NOT_FOUND', 'Miniatura indisponível');
      }
      if (!this.opts.storage.root) throw new HttpError(503, 'INTERNAL', 'Pasta de destino não configurada no PC');

      if (method === 'HEAD') {
        const received = await this.opts.storage.partSize(fileId);
        res.writeHead(200, { ...CORS_HEADERS, 'X-Arkivo-Received': String(received), 'Content-Length': '0' }).end();
        return;
      }
      if (method === 'PUT') {
        await this.handlePut(req, res, fileId, auth.phoneId);
        return;
      }
      throw new HttpError(405, 'VALIDATION_ERROR', 'Método não suportado');
    } catch (err) {
      if (err instanceof HttpError) {
        // Corpo não lido: descarta para a conexão poder ser reaproveitada/fechada sem erro no cliente.
        if (!req.complete) {
          res.setHeader('Connection', 'close');
          req.resume();
        }
        this.sendError(res, err);
        return;
      }
      throw err;
    }
  }

  private async handlePut(req: http.IncomingMessage, res: http.ServerResponse, fileId: string, phoneId: string): Promise<void> {
    const h = req.headers;
    const hash = String(h[LAN_HEADERS.hash] ?? '').toLowerCase();
    if (!HEX64.test(hash)) throw new HttpError(400, 'VALIDATION_ERROR', 'X-Arkivo-Hash ausente ou inválido');
    let name: string;
    try {
      name = decodeURIComponent(String(h[LAN_HEADERS.name] ?? ''));
    } catch {
      throw new HttpError(400, 'VALIDATION_ERROR', 'X-Arkivo-Name inválido');
    }
    if (!name.trim()) throw new HttpError(400, 'VALIDATION_ERROR', 'X-Arkivo-Name ausente');
    const takenAt = h[LAN_HEADERS.takenAt] ? String(h[LAN_HEADERS.takenAt]) : null;
    const kindRaw = String(h[LAN_HEADERS.kind] ?? '');
    const kind = (KINDS as string[]).includes(kindRaw) ? (kindRaw as FileKind) : null;

    const lenHeader = h['content-length'];
    const contentLength = lenHeader !== undefined ? Number(lenHeader) : null;
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Content-Length inválido');
    }

    let start = 0;
    let total: number;
    let expectedEnd: number;
    const rangeHeader = h['content-range'];
    if (rangeHeader) {
      const r = CONTENT_RANGE.exec(String(rangeHeader).trim());
      if (!r) throw new HttpError(400, 'VALIDATION_ERROR', 'Content-Range inválido');
      start = Number(r[1]);
      const end = Number(r[2]);
      total = Number(r[3]);
      if (![start, end, total].every(Number.isSafeInteger) || end < start || end >= total) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Content-Range inválido');
      }
      if (contentLength !== null && contentLength !== end - start + 1) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Content-Length não bate com Content-Range');
      }
      expectedEnd = end + 1;
    } else {
      if (contentLength === null) throw new HttpError(411, 'VALIDATION_ERROR', 'Content-Length obrigatório');
      total = contentLength;
      expectedEnd = total;
    }

    if (this.busy.has(fileId)) {
      // 423 (não 409): 409 significa "hash errado" para o celular. Aqui é só esperar e tentar de novo.
      throw new HttpError(UPLOAD_STATUS.BUSY, 'CONFLICT', 'Este arquivo já está sendo recebido');
    }
    this.busy.add(fileId);
    try {
      await this.opts.storage.ensurePartsDir();
      const partPath = this.opts.storage.partPath(fileId);
      const have = await this.opts.storage.partSize(fileId);
      const decision = chunkStartDecision(start, have);
      if (decision === 'gap') {
        throw new HttpError(UPLOAD_STATUS.RANGE_GAP, 'CONFLICT', 'Faltam bytes antes deste pedaço', { 'X-Arkivo-Received': String(have) });
      }

      const free = await (this.opts.freeBytes ?? (() => this.opts.storage.freeBytes()))();
      if (free < total - start + this.margin) {
        throw new HttpError(507, 'QUOTA_EXCEEDED', 'Pouco espaço livre no PC para receber este arquivo');
      }

      // Retomada: corta o que vier depois de `start` (pedaço reenviado) e acrescenta.
      if (decision === 'rewrite') await fsp.truncate(partPath, start).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') await fsp.writeFile(partPath, '');
        else throw e;
      });

      const ev: LanUploadEvent = { fileId, name, kind, takenAt, received: start, total };
      this.emit('progress', { ...ev });
      const limit = expectedEnd - start;
      let written = 0;
      let lastEmit = 0;
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          written += chunk.length;
          if (written > limit) return cb(new HttpError(400, 'VALIDATION_ERROR', 'Corpo maior que o anunciado'));
          const t = this.now();
          if (t - lastEmit > 200) {
            lastEmit = t;
            this.emit('progress', { ...ev, received: start + written });
          }
          cb(null, chunk);
        },
      });
      try {
        // Só resolve depois de escrever tudo → fh.sync() → close: cada 202 é dado com o pedaço no disco.
        await this.opts.storage.writePart(fileId, [bodyGuard(req), counter], { flags: 'a' });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err instanceof DiskError) throw await this.diskFailure(fileId, name, partPath, start, err);
        // Conexão caiu: o `.part` fica para retomada.
        this.log.warn(`Upload LAN interrompido (${fileId}) em ${start + written} bytes`);
        this.emit('failed', { fileId, name, reason: 'Conexão interrompida; o celular retoma de onde parou' });
        res.destroy();
        return;
      }
      const received = start + written;
      if (received < expectedEnd) {
        this.emit('failed', { fileId, name, reason: 'Pedaço incompleto' });
        throw new HttpError(400, 'VALIDATION_ERROR', 'Pedaço incompleto', { 'X-Arkivo-Received': String(received) });
      }

      if (received < total) {
        this.emit('progress', { ...ev, received });
        this.sendJson(res, UPLOAD_STATUS.CHUNK_ACCEPTED, { received }, { 'X-Arkivo-Received': String(received) });
        return;
      }

      // Arquivo completo, já com fsync e fechado: confere o SHA-256 relendo o que foi gravado.
      this.emit('verifying', { ...ev, received });
      const actual = await this.opts.storage.hashFile(partPath);
      if (actual !== hash) {
        await fsp.rm(partPath, { force: true });
        this.emit('failed', { fileId, name, reason: 'SHA-256 não confere' });
        throw new HttpError(409, 'CONFLICT', 'O SHA-256 do arquivo recebido não confere; envie de novo', { 'X-Arkivo-Received': '0' });
      }
      let placed: PlaceResult;
      try {
        // rename atômico + fsync dos diretórios; só depois o local vai para a API e o celular.
        placed = await this.opts.storage.placeVerified({ partPath, name, takenAt, hash });
        await this.opts.reportLocation(fileId, { relativePath: placed.relativePath, verifiedHash: actual });
      } catch (err) {
        if (!isNoSpace(err)) throw err;
        // Nada foi dito ao celular. Se o `.part` (conferido) ficou, ele reenvia o último pedaço e o PC
        // conclui; se já foi movido, o reenvio cai no "mesmo nome e mesmo hash" (idempotente).
        this.emit('failed', { fileId, name, reason: 'Disco do PC cheio' });
        const left = await this.opts.storage.partSize(fileId).catch(() => 0);
        throw new HttpError(507, 'QUOTA_EXCEEDED', 'O disco do PC encheu ao guardar o arquivo', { 'X-Arkivo-Received': String(left) });
      }
      this.emit('completed', {
        fileId,
        name,
        relativePath: placed.relativePath,
        size: total,
        hash: actual,
        alreadyExisted: placed.alreadyExisted,
        phoneId,
      });
      const body: LanUploadResult = { relativePath: placed.relativePath, verifiedHash: actual };
      this.sendJson(res, 200, body);
    } finally {
      this.busy.delete(fileId);
    }
  }

  /**
   * Erro do disco ao gravar um pedaço. Nunca é "conferido"; o que sobra do `.part` depende da fase:
   * - `open`/`write` (ex.: ENOSPC no meio): o arquivo volta para `start`. Tudo antes de `start` já
   *   estava lá (pedaços aceitos com 202 passaram por fsync), então o celular retoma desse ponto.
   * - `sync`/`close`: depois de um fsync que falhou o conteúdo em cache não é confiável (o kernel pode
   *   marcar as páginas como limpas sem gravá-las), então o `.part` é apagado e o envio recomeça do 0.
   * Disco cheio → 507 (o celular mostra "PC sem espaço"); outros erros → 500.
   */
  private async diskFailure(fileId: string, name: string, partPath: string, start: number, err: DiskError): Promise<HttpError> {
    let received = 0;
    if ((err.phase === 'open' || err.phase === 'write') && start > 0) {
      try {
        await fsp.truncate(partPath, start);
        received = start;
      } catch {
        received = 0;
      }
    }
    if (received === 0) await fsp.rm(partPath, { force: true }).catch(() => undefined);
    const full = isNoSpace(err);
    this.log.warn(`Upload LAN (${fileId}): ${err.message}; .part ${received ? `voltou para ${received} bytes` : 'apagado'}`);
    this.emit('failed', { fileId, name, reason: full ? 'Disco do PC cheio' : 'Erro ao gravar no disco do PC' });
    const headers = { 'X-Arkivo-Received': String(received) };
    return full
      ? new HttpError(507, 'QUOTA_EXCEEDED', 'O disco do PC encheu durante o recebimento', headers)
      : new HttpError(500, 'INTERNAL', 'Erro ao gravar no disco do PC', headers);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      ...CORS_HEADERS,
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(data)),
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }

  private sendError(res: http.ServerResponse, err: HttpError): void {
    this.sendJson(res, err.status, { error: { ...err.extra, code: err.code, message: err.message } }, err.headers);
  }
}
