// Arkivo — cifra de ponta a ponta das "Pastas liberadas" (contrato §10.6–§10.8) e assinatura das rotas
// /v1/fs/* na LAN (§10.5). Só WebCrypto (`globalThis.crypto.subtle`): Node 22+, Electron e navegador/WebView.
// Nenhum tipo do DOM aparece na API pública (a API e o PC compilam sem `lib: DOM`).

import { base64ToBytes, bytesToBase64, bytesToBase64Url, bytesToHex, utf8Decode, utf8Encode } from './encoding';
import {
  FS_BLOB_SEGMENT_BYTES,
  FS_BLOB_TAG_BYTES,
  FS_E2E_MAX_SKEW_MS,
  FS_PROTOCOL_VERSION,
  FS_RPC_MAX_ENVELOPE_BYTES,
  FS_RPC_MAX_PLAINTEXT_BYTES,
  LAN_FS_NONCE_HEADER,
  lanFsSignaturePayload,
  type LanFsSignatureInput,
} from './fs';

// -------------------------------------------------------------------------------- base

/** Tipos mínimos do WebCrypto usados aqui (evita depender do `lib: DOM` em quem consome os `.d.ts`). */
type Key = object;
interface Subtle {
  importKey(format: 'raw', data: ArrayBuffer, alg: unknown, extractable: boolean, usages: string[]): Promise<Key>;
  deriveKey(alg: unknown, base: Key, derived: unknown, extractable: boolean, usages: string[]): Promise<Key>;
  encrypt(alg: unknown, key: Key, data: ArrayBuffer): Promise<ArrayBuffer>;
  decrypt(alg: unknown, key: Key, data: ArrayBuffer): Promise<ArrayBuffer>;
  sign(alg: unknown, key: Key, data: ArrayBuffer): Promise<ArrayBuffer>;
  verify(alg: unknown, key: Key, sig: ArrayBuffer, data: ArrayBuffer): Promise<boolean>;
  digest(alg: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle: Subtle;
  getRandomValues<T extends Uint8Array>(a: T): T;
}

function webcrypto(): CryptoLike {
  const c = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto indisponível (precisa de Node 22+ ou contexto seguro no navegador)');
  return c;
}

/** Cópia num ArrayBuffer "puro" (o WebCrypto não aceita views de SharedArrayBuffer). */
function ab(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return webcrypto().getRandomValues(new Uint8Array(n));
}

/** Identificador aleatório em base64url (padrão 16 bytes = 22 caracteres): `requestId`, `uploadId`, `rid`, nonces. */
export function randomFsId(bytes = 16): string {
  return bytesToBase64Url(randomBytes(bytes));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8Encode(data) : data;
  return bytesToHex(new Uint8Array(await webcrypto().subtle.digest('SHA-256', ab(bytes))));
}

/** Decodifica o `pairKey` (base64 ou base64url) e exige 32 bytes. */
export function decodePairKey(pairKeyB64: string): Uint8Array {
  const k = decodeB64(pairKeyB64, 'pairKey');
  if (k.length !== 32) throw new FsE2eError('BAD_KEY', 'pairKey precisa ter 32 bytes');
  return k;
}

function decodeB64(v: string, what: string): Uint8Array {
  try {
    return base64ToBytes(v);
  } catch {
    throw new FsE2eError('BAD_KEY', `${what}: base64 inválido`);
  }
}

export type FsE2eErrorCode = 'BAD_KEY' | 'BAD_ENVELOPE' | 'WRONG_CONTEXT' | 'EXPIRED' | 'REPLAYED' | 'DECRYPT_FAILED' | 'BAD_PAYLOAD' | 'TOO_LARGE';

export class FsE2eError extends Error {
  constructor(
    readonly code: FsE2eErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FsE2eError';
  }
}

// -------------------------------------------------------------------------------- HMAC (LAN)

const hmacCache = new Map<string, Promise<Key>>();

function hmacKey(pairKeyB64: string): Promise<Key> {
  let k = hmacCache.get(pairKeyB64);
  if (!k) {
    k = webcrypto().subtle.importKey('raw', ab(decodePairKey(pairKeyB64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    if (hmacCache.size > 16) hmacCache.clear();
    hmacCache.set(pairKeyB64, k);
  }
  return k;
}

/** base64(HMAC-SHA256(pairKey, mensagem UTF-8)). */
export async function hmacSha256Base64(pairKeyB64: string, message: string): Promise<string> {
  const sig = await webcrypto().subtle.sign('HMAC', await hmacKey(pairKeyB64), ab(utf8Encode(message)));
  return bytesToBase64(new Uint8Array(sig));
}

/** Confere a assinatura em tempo constante (`subtle.verify`). Base64 inválido → `false`. */
export async function verifyHmacSha256Base64(pairKeyB64: string, message: string, sigB64: string): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(sigB64);
  } catch {
    return false;
  }
  if (sig.length !== 32) return false;
  return webcrypto().subtle.verify('HMAC', await hmacKey(pairKeyB64), ab(sig), ab(utf8Encode(message)));
}

export interface SignLanFsInput extends Omit<LanFsSignatureInput, 'ts' | 'nonce'> {
  pairKey: string;
  phoneDeviceId: string;
  now?: number;
  nonce?: string;
}

/**
 * Cabeçalhos de autenticação de uma rota `/v1/fs/*` (§10.5): `X-Arkivo-Device`, `X-Arkivo-Ts`, `X-Arkivo-Nonce`
 * e `X-Arkivo-Sig` = base64(HMAC-SHA256(pairKey, `lanFsSignaturePayload`)).
 */
export async function signLanFsRequest(i: SignLanFsInput): Promise<Record<string, string>> {
  const ts = String(i.now ?? Date.now());
  const nonce = i.nonce ?? randomFsId(16);
  const payload = lanFsSignaturePayload({ method: i.method, path: i.path, query: i.query, ts, nonce, bodySha256: i.bodySha256 });
  return {
    'x-arkivo-device': i.phoneDeviceId,
    'x-arkivo-ts': ts,
    [LAN_FS_NONCE_HEADER]: nonce,
    'x-arkivo-sig': await hmacSha256Base64(i.pairKey, payload),
  };
}

// -------------------------------------------------------------------------------- chaves (HKDF)

/** Rótulos de domínio da derivação (mudam junto com `FS_PROTOCOL_VERSION`). */
export const FS_E2E_LABELS = {
  salt: `arkivo-fs-e2e/${FS_PROTOCOL_VERSION}`,
  rpcInfo: (pcDeviceId: string) => `arkivo-fs-e2e/${FS_PROTOCOL_VERSION}/rpc|${pcDeviceId}`,
  blobInfo: (pcDeviceId: string, blobId: string) => `arkivo-fs-e2e/${FS_PROTOCOL_VERSION}/blob|${pcDeviceId}|${blobId}`,
  aad: `arkivo-fs-e2e/${FS_PROTOCOL_VERSION}`,
  blobAad: `arkivo-fs-blob/${FS_PROTOCOL_VERSION}`,
} as const;

/**
 * Chaves de um par (conta ↔ PC). Opaco: guarde e reutilize (a derivação custa um `importKey` + `deriveKey`).
 * - RPC: `HKDF-SHA256(ikm = pairKey, salt = "arkivo-fs-e2e/1", info = "arkivo-fs-e2e/1/rpc|<pcDeviceId>")` → AES-256-GCM.
 * - Blob: `HKDF-SHA256(ikm = pairKey, salt = blobSalt (16 bytes), info = "arkivo-fs-e2e/1/blob|<pcDeviceId>|<blobId>")`.
 */
export class FsE2eKeys {
  private constructor(
    readonly pcDeviceId: string,
    private readonly base: Key,
    private readonly rpc: Key,
  ) {}

  static async derive(pairKeyB64: string, pcDeviceId: string): Promise<FsE2eKeys> {
    if (!pcDeviceId) throw new FsE2eError('BAD_KEY', 'pcDeviceId vazio');
    const s = webcrypto().subtle;
    const base = await s.importKey('raw', ab(decodePairKey(pairKeyB64)), 'HKDF', false, ['deriveKey']);
    const rpc = await s.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: ab(utf8Encode(FS_E2E_LABELS.salt)), info: ab(utf8Encode(FS_E2E_LABELS.rpcInfo(pcDeviceId))) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return new FsE2eKeys(pcDeviceId, base, rpc);
  }

  /** @internal */
  rpcKey(): Key {
    return this.rpc;
  }

  /** Chave de um blob (§10.7). `saltB64Url` = 16 bytes em base64url, gerado por quem cifra (`newFsBlobSalt`). */
  async blobKey(blobId: string, saltB64Url: string, plainSize: number): Promise<FsBlobKey> {
    const salt = decodeB64(saltB64Url, 'blobSalt');
    if (salt.length !== 16) throw new FsE2eError('BAD_KEY', 'blobSalt precisa ter 16 bytes');
    if (!Number.isSafeInteger(plainSize) || plainSize < 0) throw new FsE2eError('BAD_KEY', 'tamanho inválido');
    const key = await webcrypto().subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(utf8Encode(FS_E2E_LABELS.blobInfo(this.pcDeviceId, blobId))) },
      this.base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return new FsBlobKey(blobId, plainSize, key);
  }
}

export function deriveFsE2eKeys(pairKeyB64: string, pcDeviceId: string): Promise<FsE2eKeys> {
  return FsE2eKeys.derive(pairKeyB64, pcDeviceId);
}

// -------------------------------------------------------------------------------- envelope de RPC/evento

export type FsEnvelopeType = 'req' | 'res' | 'evt';

/**
 * Envelope cifrado (§10.6). Campos em texto claro: só identificadores aleatórios e o horário, todos amarrados
 * na AAD. A API lê `pc`, `phone`, `typ` e o tamanho; nunca o conteúdo.
 */
export interface FsEnvelope {
  v: 1;
  /** `pcDeviceId` (chave e destino). */
  pc: string;
  /** `phoneDeviceId` de quem pediu (`req`/`res`) ou `"*"` (evento para todos os celulares da conta). */
  phone: string;
  /** Id aleatório da mensagem (base64url, 16 bytes). A resposta repete o `rid` do pedido. */
  rid: string;
  typ: FsEnvelopeType;
  /** Unix ms de quem cifrou. */
  ts: number;
  /** Nonce AES-GCM, 12 bytes em base64url. */
  n: string;
  /** Texto cifrado + tag (16 bytes) em base64url. */
  ct: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** AAD: `arkivo-fs-e2e/1\n<pc>\n<phone>\n<rid>\n<typ>\n<ts>`. */
export function fsEnvelopeAad(h: Pick<FsEnvelope, 'pc' | 'phone' | 'rid' | 'typ' | 'ts'>): string {
  return [FS_E2E_LABELS.aad, h.pc, h.phone, h.rid, h.typ, String(h.ts)].join('\n');
}

/**
 * Valida a forma do envelope sem a chave (a API usa antes de repassar). `null` = malformado.
 * `maxBytes` limita o tamanho do JSON (padrão `FS_RPC_MAX_ENVELOPE_BYTES`).
 */
export function parseFsEnvelope(input: unknown, maxBytes = FS_RPC_MAX_ENVELOPE_BYTES): FsEnvelope | null {
  let o: unknown = input;
  if (typeof input === 'string') {
    if (input.length > maxBytes) return null;
    try {
      o = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const e = o as Record<string, unknown>;
  if (e.v !== 1) return null;
  if (typeof e.pc !== 'string' || !ID_RE.test(e.pc)) return null;
  if (typeof e.phone !== 'string' || (e.phone !== '*' && !ID_RE.test(e.phone))) return null;
  if (typeof e.rid !== 'string' || !RID_RE.test(e.rid)) return null;
  if (e.typ !== 'req' && e.typ !== 'res' && e.typ !== 'evt') return null;
  if (typeof e.ts !== 'number' || !Number.isSafeInteger(e.ts) || e.ts <= 0) return null;
  if (typeof e.n !== 'string' || e.n.length !== 16 || !B64URL_RE.test(e.n)) return null;
  // Tag de 16 bytes = pelo menos 22 caracteres; o tamanho total cabe no limite.
  if (typeof e.ct !== 'string' || e.ct.length < 22 || e.ct.length > maxBytes || !B64URL_RE.test(e.ct)) return null;
  return { v: 1, pc: e.pc, phone: e.phone, rid: e.rid, typ: e.typ, ts: e.ts, n: e.n, ct: e.ct };
}

export interface SealFsEnvelopeInput {
  phone: string;
  typ: FsEnvelopeType;
  /** Padrão: `randomFsId()`. Na resposta, use o `rid` do pedido. */
  rid?: string;
  now?: number;
  /** Padrão: `FS_RPC_MAX_PLAINTEXT_BYTES`. */
  maxPlaintextBytes?: number;
}

/** Cifra `payload` (JSON) num envelope. Texto claro acima do limite → `FsE2eError('TOO_LARGE')`. */
export async function sealFsEnvelope(keys: FsE2eKeys, input: SealFsEnvelopeInput, payload: unknown): Promise<FsEnvelope> {
  const plain = utf8Encode(JSON.stringify(payload));
  const max = input.maxPlaintextBytes ?? FS_RPC_MAX_PLAINTEXT_BYTES;
  if (plain.length > max) throw new FsE2eError('TOO_LARGE', `Mensagem com ${plain.length} bytes (máximo ${max})`);
  const header = {
    pc: keys.pcDeviceId,
    phone: input.phone,
    rid: input.rid ?? randomFsId(16),
    typ: input.typ,
    ts: Math.floor(input.now ?? Date.now()),
  };
  if (!ID_RE.test(header.phone) && header.phone !== '*') throw new FsE2eError('BAD_ENVELOPE', 'phone inválido');
  if (!RID_RE.test(header.rid)) throw new FsE2eError('BAD_ENVELOPE', 'rid inválido');
  const nonce = randomBytes(12);
  const ct = await webcrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: ab(nonce), additionalData: ab(utf8Encode(fsEnvelopeAad(header))), tagLength: 128 },
    keys.rpcKey(),
    ab(plain),
  );
  return { v: 1, ...header, n: bytesToBase64Url(nonce), ct: bytesToBase64Url(new Uint8Array(ct)) };
}

export interface OpenFsEnvelopeExpect {
  typ: FsEnvelopeType;
  /** Celular esperado (`res` no celular: o próprio id; `req` no PC: qualquer um da lista de pares, ver `allowedPhones`). */
  phone?: string;
  /** PC: celulares da conta (`GET /devices/pc/peers`). */
  allowedPhones?: ReadonlySet<string>;
  /** Celular, ao abrir a resposta: o `rid` do pedido. */
  rid?: string;
  now?: number;
  maxSkewMs?: number;
  /** Anti-replay (o PC usa um por processo). Só registra o `rid` depois de decifrar com sucesso. */
  replay?: FsReplayGuard;
}

export interface OpenedFsEnvelope<T = unknown> {
  envelope: FsEnvelope;
  payload: T;
}

/**
 * Confere contexto (pc, typ, phone, rid), janela de horário, decifra (AAD inclui tudo do cabeçalho) e
 * aplica o anti-replay. Erros saem como `FsE2eError` com código.
 */
export async function openFsEnvelope<T = unknown>(keys: FsE2eKeys, input: unknown, expect: OpenFsEnvelopeExpect): Promise<OpenedFsEnvelope<T>> {
  const env = parseFsEnvelope(input);
  if (!env) throw new FsE2eError('BAD_ENVELOPE', 'Envelope malformado');
  if (env.pc !== keys.pcDeviceId || env.typ !== expect.typ) throw new FsE2eError('WRONG_CONTEXT', 'Envelope de outro PC ou de outro tipo');
  if (expect.phone !== undefined && env.phone !== expect.phone) throw new FsE2eError('WRONG_CONTEXT', 'Envelope de outro celular');
  if (expect.allowedPhones && !expect.allowedPhones.has(env.phone)) throw new FsE2eError('WRONG_CONTEXT', 'Celular fora da conta');
  if (expect.rid !== undefined && env.rid !== expect.rid) throw new FsE2eError('WRONG_CONTEXT', 'Resposta de outro pedido');
  const now = expect.now ?? Date.now();
  const skew = expect.maxSkewMs ?? FS_E2E_MAX_SKEW_MS;
  if (Math.abs(now - env.ts) > skew) throw new FsE2eError('EXPIRED', 'Horário fora da janela; confira o relógio do celular e do PC');
  let plain: ArrayBuffer;
  try {
    plain = await webcrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: ab(base64ToBytes(env.n)), additionalData: ab(utf8Encode(fsEnvelopeAad(env))), tagLength: 128 },
      keys.rpcKey(),
      ab(base64ToBytes(env.ct)),
    );
  } catch {
    throw new FsE2eError('DECRYPT_FAILED', 'Não foi possível abrir a mensagem (chave errada ou conteúdo alterado)');
  }
  if (expect.replay && !expect.replay.accept(`${env.phone}|${env.typ}|${env.rid}`, env.ts, now)) {
    throw new FsE2eError('REPLAYED', 'Mensagem repetida');
  }
  let payload: T;
  try {
    payload = JSON.parse(utf8Decode(new Uint8Array(plain))) as T;
  } catch {
    throw new FsE2eError('BAD_PAYLOAD', 'Conteúdo inválido');
  }
  return { envelope: env, payload };
}

/**
 * Anti-replay em memória: aceita cada chave uma única vez dentro da janela. Entradas mais velhas que a janela
 * são descartadas (mensagens com horário fora dela já são recusadas por `EXPIRED`).
 */
export class FsReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 2 * FS_E2E_MAX_SKEW_MS,
    private readonly maxEntries = 50_000,
  ) {}

  /** `true` = primeira vez (registra); `false` = repetida. */
  accept(key: string, ts: number, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) return false; // sob ataque: recusa em vez de esquecer
    this.seen.set(key, Math.max(ts, now));
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [k, at] of this.seen) {
      if (now - at > this.windowMs) this.seen.delete(k);
    }
  }
}

// -------------------------------------------------------------------------------- blobs em pedaços (§10.7)

/** Sal novo para um blob (16 bytes em base64url). */
export function newFsBlobSalt(): string {
  return randomFsId(16);
}

/** Pedaços de um arquivo de `plainSize` bytes (arquivo vazio = 1 pedaço só com a tag). */
export function fsBlobSegmentCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / FS_BLOB_SEGMENT_BYTES));
}

/** Tamanho do blob cifrado: texto claro + 16 bytes por pedaço. */
export function fsBlobCipherSize(plainSize: number): number {
  return plainSize + fsBlobSegmentCount(plainSize) * FS_BLOB_TAG_BYTES;
}

/** Inverso de `fsBlobCipherSize`; `null` se `cipherSize` não corresponde a nenhum tamanho válido. */
export function fsBlobPlainSize(cipherSize: number): number | null {
  if (!Number.isSafeInteger(cipherSize) || cipherSize < FS_BLOB_TAG_BYTES) return null;
  const n = Math.ceil(cipherSize / (FS_BLOB_SEGMENT_BYTES + FS_BLOB_TAG_BYTES));
  const plain = cipherSize - n * FS_BLOB_TAG_BYTES;
  return plain >= 0 && fsBlobCipherSize(plain) === cipherSize ? plain : null;
}

export interface FsBlobSegmentRange {
  index: number;
  plainStart: number;
  plainLength: number;
  cipherStart: number;
  cipherLength: number;
  last: boolean;
}

/** Onde fica o pedaço `index` no texto claro e no blob cifrado (para ler/retomar com `Range`). */
export function fsBlobSegment(plainSize: number, index: number): FsBlobSegmentRange {
  const count = fsBlobSegmentCount(plainSize);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Pedaço fora do blob');
  const plainStart = index * FS_BLOB_SEGMENT_BYTES;
  const plainLength = Math.min(FS_BLOB_SEGMENT_BYTES, plainSize - plainStart);
  return {
    index,
    plainStart,
    plainLength,
    cipherStart: index * (FS_BLOB_SEGMENT_BYTES + FS_BLOB_TAG_BYTES),
    cipherLength: plainLength + FS_BLOB_TAG_BYTES,
    last: index === count - 1,
  };
}

/** AAD do pedaço: `arkivo-fs-blob/1\n<blobId>\n<index>\n<1 se último>\n<plainSize>` (impede cortar, reordenar ou trocar). */
export function fsBlobSegmentAad(blobId: string, index: number, last: boolean, plainSize: number): string {
  return [FS_E2E_LABELS.blobAad, blobId, String(index), last ? '1' : '0', String(plainSize)].join('\n');
}

/** Nonce determinístico do pedaço: 4 bytes zero + índice em 64 bits big-endian (a chave é única por blob). */
function segmentNonce(index: number): Uint8Array {
  const n = new Uint8Array(12);
  let v = index;
  for (let i = 11; i >= 4; i--) {
    n[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return n;
}

/**
 * Chave de um blob. A cifra é determinística dado (chave, pedaço): cifrar duas vezes dá os mesmos bytes, então
 * quem envia pode calcular o SHA-256 do blob numa primeira passada e reenviar qualquer pedaço depois (§4.1).
 */
export class FsBlobKey {
  constructor(
    readonly blobId: string,
    readonly plainSize: number,
    private readonly key: Key,
  ) {}

  get segmentCount(): number {
    return fsBlobSegmentCount(this.plainSize);
  }

  get cipherSize(): number {
    return fsBlobCipherSize(this.plainSize);
  }

  async sealSegment(index: number, plain: Uint8Array): Promise<Uint8Array> {
    const seg = fsBlobSegment(this.plainSize, index);
    if (plain.length !== seg.plainLength) throw new FsE2eError('BAD_PAYLOAD', `Pedaço ${index} com ${plain.length} bytes (esperado ${seg.plainLength})`);
    const ct = await webcrypto().subtle.encrypt(
      { name: 'AES-GCM', iv: ab(segmentNonce(index)), additionalData: ab(utf8Encode(fsBlobSegmentAad(this.blobId, index, seg.last, this.plainSize))), tagLength: 128 },
      this.key,
      ab(plain),
    );
    return new Uint8Array(ct);
  }

  async openSegment(index: number, cipher: Uint8Array): Promise<Uint8Array> {
    const seg = fsBlobSegment(this.plainSize, index);
    if (cipher.length !== seg.cipherLength) throw new FsE2eError('DECRYPT_FAILED', `Pedaço ${index} com tamanho errado`);
    try {
      const pt = await webcrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: ab(segmentNonce(index)), additionalData: ab(utf8Encode(fsBlobSegmentAad(this.blobId, index, seg.last, this.plainSize))), tagLength: 128 },
        this.key,
        ab(cipher),
      );
      return new Uint8Array(pt);
    } catch {
      throw new FsE2eError('DECRYPT_FAILED', `Pedaço ${index} alterado ou chave errada`);
    }
  }
}
