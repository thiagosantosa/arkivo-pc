// Pastas liberadas: assinatura das rotas `/v1/fs/*` na LAN (contrato §10.5). Texto canônico do shared
// (`lanFsSignaturePayload`), query recalculada (`parseFsQuery` + `canonicalFsQuery`), nonce anti-replay.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { LAN_FS_NONCE_HEADER, LAN_FS_NONCE_RE, LAN_HEADERS, LAN_SIG_MAX_SKEW_MS, lanFsSignaturePayload } from '@arkivo/shared';
import type { LanAuthContext } from './lan-auth';

/** Nonces vistos nos últimos 240 s (o dobro da janela de horário): repetido → 401. */
export const LAN_FS_NONCE_TTL_MS = 2 * LAN_SIG_MAX_SKEW_MS;

export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = LAN_FS_NONCE_TTL_MS,
    private readonly maxEntries = 100_000,
  ) {}

  /** `true` = primeira vez (registra). */
  accept(nonce: string, now: number): boolean {
    for (const [k, at] of this.seen) {
      if (now - at <= this.ttlMs) break; // Map em ordem de inserção: o resto é mais novo
      this.seen.delete(k);
    }
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.maxEntries) return false; // sob ataque: recusa em vez de esquecer
    this.seen.set(nonce, now);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface LanFsAuthInput {
  method: string;
  /** Caminho da linha da requisição, sem query. */
  path: string;
  /** `canonicalFsQuery(parseFsQuery(query recebida))`. */
  query: string;
  headers: Record<string, string | string[] | undefined>;
  /** POST: SHA-256 dos bytes do corpo; PUT: `X-Arkivo-Hash`; demais: vazio. */
  bodySha256: string;
  now: number;
}

export type LanFsAuthResult =
  { ok: true; phoneId: string } | { ok: false; status: 401 | 403; code: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string };

function header(h: LanFsAuthInput['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Assina como o celular (testes e ferramentas). Mesmo texto de `signLanFsRequest` do shared. */
export function signLanFsPayload(pairKey: string, input: Omit<LanFsAuthInput, 'headers' | 'now'> & { ts: string; nonce: string }): string {
  return createHmac('sha256', Buffer.from(pairKey, 'base64'))
    .update(
      lanFsSignaturePayload({
        method: input.method,
        path: input.path,
        query: input.query,
        ts: input.ts,
        nonce: input.nonce,
        bodySha256: input.bodySha256,
      }),
    )
    .digest('base64');
}

/**
 * Confere a assinatura de uma rota `/v1/fs/*`. O nonce só é registrado depois de a assinatura conferir
 * (um pedido forjado não "queima" o nonce de um legítimo).
 */
export function verifyLanFsRequest(input: LanFsAuthInput, ctx: LanAuthContext | null, nonces: NonceCache): LanFsAuthResult {
  const deny = (message: string): LanFsAuthResult => ({ ok: false, status: 401, code: 'UNAUTHORIZED', message });
  if (!ctx?.pairKey) return deny('Este PC não está pareado');
  const phoneId = header(input.headers, LAN_HEADERS.device);
  const ts = header(input.headers, LAN_HEADERS.ts);
  const sig = header(input.headers, LAN_HEADERS.sig);
  const nonce = header(input.headers, LAN_FS_NONCE_HEADER);
  if (!phoneId || !ts || !sig) return deny('Assinatura ausente');
  if (!nonce || !LAN_FS_NONCE_RE.test(nonce)) return deny('Nonce ausente ou inválido');
  if (!/^\d{1,16}$/.test(ts)) return deny('Horário inválido');
  if (Math.abs(input.now - Number(ts)) > LAN_SIG_MAX_SKEW_MS)
    return deny('Horário fora da janela de 120 s; confira o relógio do celular e do PC');
  const expected = Buffer.from(
    signLanFsPayload(ctx.pairKey, { method: input.method, path: input.path, query: input.query, ts, nonce, bodySha256: input.bodySha256 }),
    'base64',
  );
  const given = Buffer.from(sig, 'base64');
  const same = given.length === expected.length;
  // Sempre compara buffers do mesmo tamanho (tempo constante).
  if (!(timingSafeEqual(same ? given : expected, expected) && same)) return deny('Assinatura inválida');
  if (!nonces.accept(`${phoneId}|${nonce}`, input.now)) return deny('Pedido repetido');
  if (!ctx.allowedPhones.has(phoneId))
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Este celular não está pareado com este PC' };
  return { ok: true, phoneId };
}
