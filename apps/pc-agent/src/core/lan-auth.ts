import { createHmac, timingSafeEqual } from 'node:crypto';
import { LAN_HEADERS, LAN_SIG_MAX_SKEW_MS, lanSignaturePayload } from '@arkivo/shared';

export interface LanAuthContext {
  /** `pairKey` em base64 (32 bytes), recebido no pareamento. */
  pairKey: string;
  /** IDs dos celulares do mesmo usuário (`GET /v1/devices/pc/peers`). */
  allowedPhones: ReadonlySet<string>;
}

export interface LanAuthInput {
  method: string;
  /** Caminho da requisição como chegou (só o pathname, sem host e sem query — contrato §3.3). */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  now: number;
}

export type LanAuthResult =
  | { ok: true; phoneId: string }
  | { ok: false; status: 401 | 403; code: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string };

const HEX64 = /^[0-9a-f]{64}$/;

function header(h: LanAuthInput['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Calcula a assinatura (base64) que o celular deve mandar em `X-Arkivo-Sig`. */
export function signLanRequest(pairKey: string, method: string, path: string, ts: string | number, sha256Hex = ''): string {
  return createHmac('sha256', Buffer.from(pairKey, 'base64'))
    .update(lanSignaturePayload(method, path, ts, sha256Hex))
    .digest('base64');
}

/**
 * Verifica a assinatura HMAC do §3.3.
 * O hash assinado é o de `X-Arkivo-Hash` quando presente (PUT sempre manda), senão vazio (HEAD).
 */
export function verifyLanRequest(input: LanAuthInput, ctx: LanAuthContext | null): LanAuthResult {
  const deny = (message: string): LanAuthResult => ({ ok: false, status: 401, code: 'UNAUTHORIZED', message });
  if (!ctx || !ctx.pairKey) return deny('Este PC não está pareado');

  const phoneId = header(input.headers, LAN_HEADERS.device);
  const tsRaw = header(input.headers, LAN_HEADERS.ts);
  const sig = header(input.headers, LAN_HEADERS.sig);
  const hash = (header(input.headers, LAN_HEADERS.hash) ?? '').toLowerCase();
  if (!phoneId || !tsRaw || !sig) return deny('Assinatura ausente');
  if (hash && !HEX64.test(hash)) return deny('Hash inválido');

  if (!/^\d{1,16}$/.test(tsRaw)) return deny('Horário inválido');
  const ts = Number(tsRaw);
  if (Math.abs(input.now - ts) > LAN_SIG_MAX_SKEW_MS) return deny('Horário fora da janela de 120 s; confira o relógio do celular e do PC');

  const expected = Buffer.from(signLanRequest(ctx.pairKey, input.method, input.path, tsRaw, hash), 'base64');
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64');
  } catch {
    return deny('Assinatura inválida');
  }
  // Compara sempre buffers do mesmo tamanho para não vazar informação por tempo.
  const sameLength = given.length === expected.length;
  const ok = timingSafeEqual(sameLength ? given : expected, expected) && sameLength;
  if (!ok) return deny('Assinatura inválida');

  // Só depois de autenticar revelamos se o celular pertence ao usuário.
  if (!ctx.allowedPhones.has(phoneId)) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Este celular não está pareado com este PC' };
  }
  return { ok: true, phoneId };
}
