// Arkivo — tipos compartilhados. Espelha docs/CONTRACT.md. Não altere sem atualizar o contrato.

import type { ClientKind } from './protocol';
import type { FsEnvelope } from './e2e';
import type { FsBlobInfo } from './fs';
export * from './protocol';
// [2026-11-04] Pastas liberadas (contrato §10).
export * from './encoding';
export * from './fs';
export * from './e2e';

export const API_VERSION = 'v1';
export const PC_LAN_PORT = 47800;
export const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
export const PAIRING_TTL_SECONDS = 300;
export const LAN_SIG_MAX_SKEW_MS = 120_000;

/** Códigos HTTP do envio em pedaços (relay e LAN usam as mesmas regras, contrato §4 Relay e §6). */
export const UPLOAD_STATUS = {
  /** Pedaço intermediário aceito (sempre com `X-Arkivo-Received`). */
  CHUNK_ACCEPTED: 202,
  /** `start` do `Content-Range` passa do que o servidor tem (buraco). Vem com `X-Arkivo-Received`. */
  RANGE_GAP: 416,
  /** O mesmo arquivo já está sendo recebido por outra conexão; tente de novo em instantes. */
  BUSY: 423,
} as const;

/** Códigos de fechamento do WebSocket (contrato §5). */
export const WS_CLOSE = {
  /** Credencial ausente, inválida ou expirada: o celular renova o access token; o PC confere `GET /devices/pc/self`. */
  UNAUTHORIZED: 4401,
  /** PC removido da conta ou conta apagada. */
  REVOKED: 4001,
  /** `client`/`protocol` (cabeçalho ou query) malformado: erro de programação; o cliente registra e segue o backoff (contrato §9). */
  BAD_CLIENT: 4400,
  /**
   * Versão do app abaixo do mínimo ou protocolo incompatível (equivalente ao HTTP 426, contrato §9).
   * O `reason` é o JSON de `UpgradeRequiredInfo`. O cliente para de reconectar e pede a atualização.
   */
  UPGRADE_REQUIRED: 4426,
} as const;

/**
 * Regra única de retomada do PUT em pedaços (API e PC):
 * - `start > received` → `gap` (responder 416 + `X-Arkivo-Received`);
 * - `start === received` → `append`;
 * - `start < received` → `rewrite` (truncar o `.part` em `start` e gravar o pedaço).
 */
export function chunkStartDecision(start: number, received: number): 'append' | 'rewrite' | 'gap' {
  if (start > received) return 'gap';
  return start === received ? 'append' : 'rewrite';
}

export type FileKind = 'photo' | 'video' | 'document';
export type DeviceType = 'phone' | 'pc';
export type PhonePlatform = 'android' | 'ios' | 'web';
export type PcPlatform = 'windows' | 'macos' | 'linux';
export type Plan = 'free' | 'lifetime';

export interface ApiError {
  error: {
    code:
      | 'VALIDATION_ERROR'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'GONE'
      | 'PAYLOAD_TOO_LARGE'
      | 'QUOTA_EXCEEDED'
      | 'UPGRADE_REQUIRED'
      | 'PC_OFFLINE'
      | 'PC_TIMEOUT'
      | 'PC_ERROR'
      | 'INTERNAL';
    message: string;
  };
}

/** `GET /v1/health` (contrato §4 Saúde e §9). */
export interface HealthResponse {
  ok: true;
  version: string;
  /** `PROTOCOL_VERSION` da API. */
  protocol: number;
  /** Protocolo mais antigo que a API ainda aceita. */
  minProtocol: number;
  /** Versão mínima de cada app; abaixo dela a API responde `426 UPGRADE_REQUIRED`. */
  minClientVersions: Record<ClientKind, string>;
  /** [2026-11-04] Recursos opcionais da API (ex.: `['fs-rpc']`, §10.9). Ausente = nenhum (API antiga). */
  capabilities?: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  handle: string;
  mailAddress: string;
  mailEnabled: boolean;
  /**
   * [2026-11-04] E-mail confirmado pelo link enviado no cadastro. Não bloqueia o uso do app; o celular só mostra um aviso.
   * Clientes antigos podem ter um `User` salvo sem o campo: trate `undefined` como "não sei" (sem aviso).
   */
  emailVerified: boolean;
  plan: Plan;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
  handle?: string;
  /**
   * [2026-11-04] Versões dos Termos de Uso e da Política de Privacidade mostradas no cadastro (de `GET /v1/legal`).
   * Opcionais para compatibilidade; se vierem diferentes das atuais da API → `409 CONFLICT`.
   */
  termsVersion?: string;
  privacyVersion?: string;
}

/** [2026-11-04] Versões atuais dos documentos legais (`docs/legal/`). A API pode sobrescrever por env. */
export const TERMS_VERSION = '0.1';
export const PRIVACY_VERSION = '0.1';

/** [2026-11-04] `GET /v1/legal` */
export interface LegalInfo {
  termsVersion: string;
  privacyVersion: string;
  /** `<APP_PUBLIC_URL>/termos` */
  termsUrl: string;
  /** `<APP_PUBLIC_URL>/privacidade` */
  privacyUrl: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

// ---------- conta: e-mail, senha, sessões e dados [2026-11-04] ----------
/** Validade do link de confirmação de e-mail. */
export const EMAIL_VERIFICATION_TTL_HOURS = 24;
/** Validade do link de troca de senha. */
export const PASSWORD_RESET_TTL_MINUTES = 60;
/** Validade do link de download da exportação de dados. */
export const DATA_EXPORT_TTL_HOURS = 24;
/** Intervalo mínimo entre duas exportações da mesma conta. */
export const DATA_EXPORT_MIN_INTERVAL_MINUTES = 60;
/** Senha nova: mesmo mínimo do cadastro. */
export const PASSWORD_MIN_LENGTH = 8;

/** `POST /v1/auth/verify-email` */
export interface VerifyEmailRequest {
  token: string;
}

/** `POST /v1/auth/forgot-password` (sempre 204, exista ou não a conta) */
export interface ForgotPasswordRequest {
  email: string;
}

/** `POST /v1/auth/reset-password` → 204 */
export interface ResetPasswordRequest {
  token: string;
  password: string;
}

/** `DELETE /v1/me`: a senha atual é obrigatória. */
export interface DeleteAccountRequest {
  password: string;
}

/** `POST /v1/me/export` → 202 */
export interface DataExportResponse {
  message: string;
  /** Link de download (`GET /v1/me/export/:token`), sem autenticação; também vai por e-mail. */
  downloadUrl: string;
  expiresAt: string;
}

/** Conteúdo do JSON baixado em `GET /v1/me/export/:token`. */
export interface DataExportFile {
  format: 'arkivo-data-export';
  version: 1;
  exportedAt: string;
  user: User & {
    emailVerifiedAt: string | null;
    passwordChangedAt: string | null;
    /** Aceite registrado no cadastro (null em contas anteriores a 2026-11-04). */
    termsVersion: string | null;
    privacyVersion: string | null;
    termsAcceptedAt: string | null;
  };
  devices: Device[];
  /** Só metadados: o conteúdo das fotos e vídeos fica no PC do usuário. */
  files: FileRecord[];
  /** Sessões abertas no celular (sem os tokens). */
  sessions: { createdAt: string; expiresAt: string; userAgent: string | null }[];
  /** Trilha de auditoria da conta (último ano). */
  auditLog: { action: string; at: string; ip: string | null; userAgent: string | null; meta: Record<string, unknown> }[];
}

export interface Device {
  id: string;
  type: DeviceType;
  name: string;
  platform: PhonePlatform | PcPlatform;
  online: boolean;
  lastSeenAt: string | null;
  lanAddresses: string[];
  lanPort: number | null;
  freeBytes: number | null;
  folderLabel: string | null;
  createdAt: string;
  /**
   * [2026-11-04] Recursos anunciados pelo PC (ex.: `['fs']`, §10.9). A API nova sempre manda (vazio para celular);
   * ausente = API antiga = nenhum.
   */
  capabilities?: string[];
}

export interface RegisterPhoneRequest {
  name: string;
  platform: PhonePlatform;
  model?: string;
  installId?: string;
  /** [2026-11-04] Recursos deste celular (`['fs-push']`, §11). A API repassa ao PC na lista de celulares. */
  capabilities?: string[];
}

/** Um celular da conta, como o PC vê (`GET /v1/devices/pc/peers` e `peers.changed`). */
export interface PeerPhoneInfo {
  id: string;
  name: string;
  /** [2026-11-04] Recursos do celular (§11). Ausente ou sem `fs-push` = não dá para saber se recebe: precisa atualizar. */
  capabilities?: string[];
}

export interface PcSelfUpdate {
  lanAddresses?: string[];
  lanPort?: number;
  freeBytes?: number;
  folderLabel?: string;
  appVersion?: string;
  /** [2026-11-04] Recursos do PC (§10.9). */
  capabilities?: string[];
}

export interface CreatePairingRequest {
  pcName: string;
  platform: PcPlatform;
}

export interface CreatePairingResponse {
  pairingId: string;
  code: string;
  pollToken: string;
  expiresAt: string;
  qrPayload: string; // arkivo://pair?id=<id>&code=<code>&v=1
}

export interface ClaimPairingRequest {
  code: string;
  phoneDeviceId: string;
}

export interface PairingClaimResult {
  pc: Device;
  pairKey: string; // base64, 32 bytes
}

/** Dono da conta, mostrado no PC depois do pareamento ("Conectado como ..."). */
export interface PairingUser {
  name: string;
  handle: string;
  email: string;
}

export interface PairingPollResponse {
  status: 'pending' | 'claimed' | 'expired';
  deviceId?: string;
  deviceToken?: string;
  pairKey?: string;
  user?: PairingUser;
}

export interface FileLocation {
  deviceId: string;
  type: DeviceType;
  relativePath: string | null;
  verifiedAt: string | null;
}

export interface FileRecord {
  id: string;
  hash: string;
  name: string;
  kind: FileKind;
  size: number;
  mimeType: string;
  takenAt: string;
  createdAt: string;
  updatedAt: string;
  locations: FileLocation[];
  onPhone: boolean;
  status: 'pending' | 'verified';
}

export interface CreateFileRequest {
  hash: string;
  name: string;
  kind: FileKind;
  size: number;
  mimeType: string;
  takenAt: string;
  sourceDeviceId: string;
}

export interface FileListResponse {
  items: FileRecord[];
  nextCursor: string | null;
}

export interface FileStats {
  totalCount: number;
  totalBytes: number;
  verifiedCount: number;
  verifiedBytes: number;
  onPhoneVerifiedBytes: number;
  byMonth: { month: string; count: number }[];
}

export interface LocationReport {
  relativePath: string;
  verifiedHash: string;
}

export type TransferStatus = 'uploading' | 'ready' | 'downloading' | 'done' | 'failed' | 'expired';

export interface Transfer {
  id: string;
  fileId: string;
  file: FileRecord;
  targetDeviceId: string;
  mode: 'relay';
  status: TransferStatus;
  bytesReceived: number;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailStatus {
  enabled: boolean;
  address: string;
  provider: 'stalwart' | 'disabled';
}

// ---------- WebSocket ----------
/** Máximo de ids por evento `files.unverified`. */
export const FILES_UNVERIFIED_BATCH = 500;

export type WsMessage =
  | { type: 'transfer.ready'; data: { transfer: Transfer } }
  | { type: 'device.revoked'; data: Record<string, never> }
  | { type: 'peers.changed'; data: { phones: PeerPhoneInfo[] } }
  | { type: 'file.verified'; data: { file: FileRecord } }
  | {
      type: 'device.status';
      data: {
        deviceId: string;
        online: boolean;
        lanAddresses: string[];
        lanPort: number | null;
        freeBytes: number | null;
        /** [2026-11-04] Recursos do PC (§10.9); ausente = API antiga. */
        capabilities?: string[];
      };
    }
  | { type: 'pairing.revoked'; data: { pcDeviceId: string } }
  /**
   * Um PC saiu da conta e os locais dele deixaram de valer (contrato §4 Arquivos e §7.1).
   * Os arquivos listados não estão mais "conferidos" por aquele PC; o `FileRecord` atual vem de `GET /files/:id`.
   * Vem em lotes de até `FILES_UNVERIFIED_BATCH` ids.
   */
  | { type: 'files.unverified'; data: { pcDeviceId: string; fileIds: string[] } }
  | { type: 'transfer.updated'; data: { transfer: Transfer } }
  | {
      type: 'pairing.claimed';
      data: { deviceId: string; deviceToken: string; pairKey: string; user: PairingUser };
    }
  | { type: 'pairing.expired'; data: Record<string, never> }
  | {
      type: 'pc.status';
      /** [2026-11-04] `capabilities` opcional (§10.9): a API grava em `Device.capabilities`. */
      data: { lanAddresses: string[]; lanPort: number; freeBytes: number; receiving: boolean; capabilities?: string[] };
    }
  // ----- [2026-11-04] Pastas liberadas (contrato §10.6, §10.7). O conteúdo vai sempre cifrado (`FsEnvelope`). -----
  /** API → PC: pedido de um celular. `rpcId` é da API (para casar a resposta); o `rid` do envelope é do celular. */
  | { type: 'fs.request'; data: { rpcId: string; phoneDeviceId: string; envelope: FsEnvelope } }
  /**
   * PC → API: resposta. `envelope` (cifrado) **ou** `error` em texto claro, só quando o PC não conseguiu abrir o
   * pedido (`E2E_FAILED`, `CLOCK_SKEW`) ou está ocupado (`BUSY`): não há nada de sensível nesses casos.
   */
  | { type: 'fs.response'; data: { rpcId: string; envelope?: FsEnvelope; error?: { code: FsPcRpcErrorCode } } }
  /** PC → API → celulares: evento cifrado (`typ: 'evt'`, `phone: '*'`). A API acrescenta `pcDeviceId` ao repassar. */
  | { type: 'fs.event'; data: { pcDeviceId?: string; envelope: FsEnvelope } }
  /** API → celulares: metadados de um blob cifrado (progresso, pronto, consumido, falhou, expirou). */
  | { type: 'fs.blob.updated'; data: { blob: FsBlobInfo } };

/** [2026-11-04] Erros em texto claro que o PC devolve em `fs.response` (a API repassa como `502 PC_ERROR`). */
export type FsPcRpcErrorCode = 'E2E_FAILED' | 'CLOCK_SKEW' | 'BUSY';

/**
 * [2026-11-04] Códigos novos da API para `POST /v1/fs-rpc/:pcDeviceId` e `/v1/fs-blobs` (§10.6, §10.7). Ficam fora de
 * `ApiError` por enquanto para não quebrar os mapas exaustivos de código da API e do celular; a equipe da API acrescenta.
 */
export type FsRpcApiErrorCode = 'PC_OFFLINE' | 'PC_TIMEOUT' | 'PC_ERROR';
export interface FsRpcApiError {
  error: { code: FsRpcApiErrorCode; message: string; reason?: FsPcRpcErrorCode };
}
/** `POST /v1/fs-rpc/:pcDeviceId` (corpo) → `200 FsRpcResponse`. */
export interface FsRpcHttpRequest {
  envelope: FsEnvelope;
}
export interface FsRpcResponse {
  envelope: FsEnvelope;
}

// ---------- LAN (celular → PC) ----------
export const LAN_HEADERS = {
  device: 'x-arkivo-device',
  ts: 'x-arkivo-ts',
  sig: 'x-arkivo-sig',
  // Versionamento (§9): os mesmos de `CLIENT_HEADERS`.
  client: 'x-arkivo-client',
  protocol: 'x-arkivo-protocol',
  hash: 'x-arkivo-hash',
  name: 'x-arkivo-name',
  takenAt: 'x-arkivo-taken-at',
  kind: 'x-arkivo-kind',
  received: 'x-arkivo-received',
} as const;

/** Texto canônico assinado com HMAC-SHA256(pairKey). */
export function lanSignaturePayload(method: string, path: string, ts: string | number, sha256Hex = ''): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${sha256Hex}`;
}

export interface LanPingResponse {
  app: 'arkivo-pc';
  deviceId: string;
  version: string;
  /** `PROTOCOL_VERSION` do PC (contrato §9). Resposta sem o campo = protocolo 1. */
  protocol: number;
  /** Protocolo mais antigo de celular que o PC aceita. */
  minProtocol: number;
  /** [2026-11-04] Recursos do PC (ex.: `['fs']`, §10.9). Ausente = nenhum. */
  capabilities?: string[];
}

export interface LanUploadResult {
  relativePath: string;
  verifiedHash: string;
}

/** Caminho relativo organizado: AAAA/MM/nome (separador "/"; o PC converte para o do SO). */
export function organizedRelativePath(takenAtIso: string, fileName: string, tzOffsetMinutes = 0): string {
  const d = new Date(new Date(takenAtIso).getTime() - tzOffsetMinutes * 60_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}/${m}/${fileName}`;
}

export function parsePairingQr(payload: string): { pairingId: string; code: string } | null {
  try {
    const u = new URL(payload);
    if (u.protocol !== 'arkivo:' || u.host !== 'pair') return null;
    const pairingId = u.searchParams.get('id');
    const code = u.searchParams.get('code');
    return pairingId && code ? { pairingId, code } : null;
  } catch {
    return null;
  }
}
