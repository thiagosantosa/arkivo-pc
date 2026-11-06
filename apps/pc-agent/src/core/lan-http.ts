// Peças HTTP comuns às rotas do backup (§6) e das pastas liberadas (§10.5) no servidor LAN.
import type http from 'node:http';
import { PassThrough } from 'node:stream';
import { CLIENT_HEADER_NAMES } from '@arkivo/shared';

/** CORS do servidor LAN: §6, ampliado pelas rotas `/v1/fs/*` (§10.5). */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'Content-Range',
    'X-Arkivo-Device',
    'X-Arkivo-Ts',
    'X-Arkivo-Sig',
    'X-Arkivo-Hash',
    'X-Arkivo-Name',
    'X-Arkivo-Taken-At',
    'X-Arkivo-Kind',
    CLIENT_HEADER_NAMES.client,
    CLIENT_HEADER_NAMES.protocol,
    'X-Arkivo-Nonce',
    'Range',
    'If-Range',
    'If-None-Match',
  ].join(', '),
  'Access-Control-Expose-Headers': 'X-Arkivo-Received, Content-Range, Accept-Ranges, Content-Length, Content-Disposition, ETag',
  'Access-Control-Max-Age': '600',
};

export function headerValue(h: http.IncomingHttpHeaders, name: string): string | null {
  const v = h[name];
  return Array.isArray(v) ? v.join(',') : (v ?? null);
}

/**
 * Corpo da requisição atrás de um `PassThrough`: se o disco falhar no meio, o `pipeline` destrói
 * só a guarda, não o `req`. Destruir o `req` com corpo pendente derruba o socket e o celular
 * nunca veria o `507`. Conexão caindo de verdade continua chegando ao `pipeline` como erro.
 */
export function bodyGuard(req: http.IncomingMessage): PassThrough {
  const guard = new PassThrough();
  req.on('error', (err) => guard.destroy(err));
  req.on('close', () => {
    if (!req.complete) guard.destroy(new Error('Conexão interrompida'));
  });
  req.pipe(guard);
  return guard;
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
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

export const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

export interface ChunkRange {
  start: number;
  /** Fim exclusivo do pedaço. */
  expectedEnd: number;
  total: number;
}

/**
 * `Content-Range`/`Content-Length` de um `PUT` em pedaços (§4.1). `null` em `error` = válido.
 * Sem `Content-Range` e sem `Content-Length` → 411.
 */
export function parseChunkRange(
  h: http.IncomingHttpHeaders,
): { ok: true; range: ChunkRange } | { ok: false; status: 400 | 411; message: string } {
  const lenHeader = h['content-length'];
  const contentLength = lenHeader !== undefined ? Number(lenHeader) : null;
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0))
    return { ok: false, status: 400, message: 'Content-Length inválido' };
  const rangeHeader = h['content-range'];
  if (rangeHeader) {
    const r = CONTENT_RANGE_RE.exec(String(rangeHeader).trim());
    if (!r) return { ok: false, status: 400, message: 'Content-Range inválido' };
    const start = Number(r[1]);
    const end = Number(r[2]);
    const total = Number(r[3]);
    if (![start, end, total].every(Number.isSafeInteger) || end < start || end >= total)
      return { ok: false, status: 400, message: 'Content-Range inválido' };
    if (contentLength !== null && contentLength !== end - start + 1)
      return { ok: false, status: 400, message: 'Content-Length não bate com Content-Range' };
    return { ok: true, range: { start, expectedEnd: end + 1, total } };
  }
  if (contentLength === null) return { ok: false, status: 411, message: 'Content-Length obrigatório' };
  return { ok: true, range: { start: 0, expectedEnd: contentLength, total: contentLength } };
}
