// Arkivo — "Pastas liberadas": acesso aos arquivos do PC pelo celular (contrato §10, [2026-11-04]) e
// "Enviar para o celular": o PC oferece arquivos ao celular (contrato §11, [2026-11-04]).
// Tipos, constantes e helpers puros (sem Node, sem DOM): rodam no PC, na API e no celular.

import { utf8ByteLength } from './encoding';

// =====================================================================================
// Constantes
// =====================================================================================

/** Versão do subprotocolo de pastas liberadas (prefixo da assinatura LAN e versão do envelope E2E). */
export const FS_PROTOCOL_VERSION = 1;

/**
 * Capacidades anunciadas (contrato §10.9). Recurso novo não sobe `PROTOCOL_VERSION`: quem não conhece ignora.
 * - `fs`: o PC atende as rotas `/v1/fs/*` na LAN e o RPC `fs.request` pelo WebSocket (`/v1/ping`, `Device.capabilities`).
 * - `fs-rpc`: a API repassa `POST /v1/fs-rpc/:pcDeviceId` e guarda blobs cifrados (`/v1/health`).
 * - `fs-push` (§11): o PC tem caixa de saída (`/v1/ping`, `pc.status`, `Device.capabilities`); o celular sabe receber
 *   (`POST /v1/devices/phone`, que chega ao PC em `GET /v1/devices/pc/peers` e `peers.changed`).
 */
export const CAPABILITIES = { fs: 'fs', fsRpc: 'fs-rpc', fsPush: 'fs-push' } as const;
export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** O par anuncia a capacidade? Lista ausente = nenhuma (build antiga). */
export function hasCapability(list: readonly string[] | null | undefined, cap: Capability): boolean {
  return Array.isArray(list) && list.includes(cap);
}

/** Maior nome (um segmento), em bytes UTF-8. Vale para NTFS (255 UTF-16) e ext4/APFS (255 bytes). */
export const FS_NAME_MAX_BYTES = 255;
/** Maior caminho relativo à raiz, em bytes UTF-8. */
export const FS_PATH_MAX_BYTES = 1024;
/** Maior profundidade (segmentos) de um caminho relativo. */
export const FS_PATH_MAX_DEPTH = 64;
/** Rótulo de uma raiz. */
export const FS_ROOT_LABEL_MAX = 64;
/** Máximo de raízes liberadas por PC. */
export const FS_MAX_ROOTS = 32;
/** `id` de raiz: gerado pelo PC, estável (16 bytes aleatórios em base64url = 22 caracteres). */
export const FS_ROOT_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
/** `uploadId`/`requestId`: gerados pelo celular (≥ 16 bytes aleatórios em base64url). */
export const FS_CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const FS_LIST_DEFAULT_LIMIT = 200;
export const FS_LIST_MAX_LIMIT = 500;
/** Itens por `move`/`trash`. */
export const FS_BATCH_MAX = 100;
/** Lados (px) aceitos para miniatura; padrão 256. */
export const FS_THUMB_SIZES = [128, 256, 512] as const;
export type FsThumbSize = (typeof FS_THUMB_SIZES)[number];
export const FS_THUMB_DEFAULT_SIZE: FsThumbSize = 256;
/** Maior JPEG de miniatura (o PC baixa a qualidade até caber). */
export const FS_THUMB_MAX_BYTES = 96 * 1024;
/** Corpo JSON das rotas `POST /v1/fs/*` na LAN. */
export const FS_LAN_JSON_MAX_BYTES = 64 * 1024;
/** Requisições mutantes repetidas com o mesmo `requestId` devolvem a resposta guardada por este tempo. */
export const FS_IDEMPOTENCY_TTL_MS = 10 * 60_000;

/** Pasta (dentro de cada raiz) com os `.part` de envios do celular. Sempre bloqueada e oculta. */
export const FS_PARTS_DIR_NAME = '.arkivo-fs-parciais';
/** Prefixo reservado: nada com este prefixo é listado, criado ou acessado pelo celular. */
export const FS_RESERVED_PREFIX = '.arkivo-';
/** Nomes que a listagem omite quando `includeHidden` é falso (lixo do sistema, não são bloqueados). */
export const FS_LIST_IGNORED_NAMES: readonly string[] = ['desktop.ini', 'thumbs.db', '.ds_store', '.localized'];

// --- transporte remoto (§10.6/§10.7) ---
/** Envelope (JSON serializado) de `fs-rpc` e de `fs.request`/`fs.response`. */
export const FS_RPC_MAX_ENVELOPE_BYTES = 256 * 1024;
/** Texto claro máximo dentro de um envelope de RPC (cabe em `FS_RPC_MAX_ENVELOPE_BYTES` depois de base64). */
export const FS_RPC_MAX_PLAINTEXT_BYTES = 180 * 1024;
/** Envelope de `fs.event`. */
export const FS_EVENT_MAX_ENVELOPE_BYTES = 32 * 1024;
/** A API espera a resposta do PC por até este tempo → `504 PC_TIMEOUT`. */
export const FS_RPC_TIMEOUT_MS = 25_000;
/** O PC responde o `upload` remoto na hora se terminar dentro deste tempo; senão `pending`. */
export const FS_UPLOAD_COMMIT_WAIT_MS = 15_000;
/** RPCs pendentes por PC na API ao mesmo tempo → `429`. */
export const FS_RPC_MAX_PENDING_PER_PC = 8;
/** Janela do anti-replay do envelope (igual à da LAN, §3.3). */
export const FS_E2E_MAX_SKEW_MS = 120_000;
/** Pedaço de texto claro de um blob cifrado (o último pode ser menor). */
export const FS_BLOB_SEGMENT_BYTES = 1024 * 1024;
/** Tag do AES-GCM acrescentada a cada pedaço. */
export const FS_BLOB_TAG_BYTES = 16;
/** Blob sem atividade expira na API depois disso. */
export const FS_BLOB_TTL_MINUTES = 60;
/** Blobs ativos (`uploading`/`ready`/`downloading`) por conta → `429`. */
export const FS_BLOB_MAX_ACTIVE_PER_USER = 10;

// --- enviar para o celular (§11) ---
/**
 * Maior blob cifrado de um item da caixa de saída (o mesmo padrão de `FS_BLOB_MAX_BYTES` na API, 2 GiB). Vale nas duas
 * vias, para o comportamento não variar: o PC confere `fsBlobCipherSize(tamanho) <= FS_PUSH_MAX_BYTES`.
 */
export const FS_PUSH_MAX_BYTES = 2 * 1024 ** 3;
/** Por quanto tempo um arquivo espera o celular no PC. */
export const FS_PUSH_TTL_MS = 7 * 24 * 3600_000;
/** Itens ativos (`waiting` + `downloading`) na caixa de saída. */
export const FS_PUSH_MAX_ACTIVE = 200;
/** Com o app aberto, o celular consulta a lista neste intervalo (o `fs.event` se perde com o app fechado). */
export const FS_PUSH_POLL_MS = 30_000;

// =====================================================================================
// Modelo
// =====================================================================================

export type FsPlatform = 'windows' | 'macos' | 'linux';

/** O que o celular vê de uma raiz. O caminho absoluto nunca sai do PC. */
export interface FsRootInfo {
  /** Estável enquanto a raiz existir (o PC gera ao adicionar; remover e adicionar de novo gera outro). */
  id: string;
  /** Nome mostrado (padrão: nome da pasta; o usuário pode mudar no PC). */
  label: string;
  /** Unidade, só para exibição: `"C:"`, `"E:"`, nome do volume no macOS/Linux; `null` se não souber. */
  drive: string | null;
  /** `false` quando a pasta não está acessível agora (HD externo desconectado, rede caiu). */
  available: boolean;
  /** Espaço livre no volume (bytes); `null` se indisponível. */
  freeBytes: number | null;
  /** Este volume tem Lixeira (`trash` funciona). Unidades removíveis e de rede normalmente não têm. */
  trashAvailable: boolean;
  addedAt: string;
}

export type FsEntryType = 'file' | 'dir';

export interface FsEntry {
  /** Nome em NFC. */
  name: string;
  type: FsEntryType;
  /** Bytes (arquivo); `null` para pasta. */
  size: number | null;
  /** Última modificação, ISO 8601 UTC. */
  mtime: string;
  /** Pelo nome da extensão (`fsMimeFromName`); `null` para pasta. */
  mime: string | null;
  /** Começa com `.` ou tem o atributo "oculto" do Windows. */
  hidden: boolean;
  /** O PC consegue gerar miniatura (`thumb`). */
  hasThumb: boolean;
}

export type FsSortKey = 'name' | 'mtime' | 'size' | 'type';
export type FsSortOrder = 'asc' | 'desc';
export type FsConflictPolicy = 'fail' | 'rename' | 'replace' | 'skip';

// ----- requisições (corpo JSON na LAN e texto claro do envelope remoto) -----

export interface FsRootsRequest {
  op: 'roots';
}
export interface FsListRequest {
  op: 'list';
  rootId: string;
  /** Relativo à raiz, com `/`; `""` = a própria raiz. */
  path: string;
  /** Opaco, devolvido em `nextCursor`. */
  cursor?: string;
  limit?: number;
  sort?: FsSortKey;
  order?: FsSortOrder;
  includeHidden?: boolean;
}
export interface FsStatRequest {
  op: 'stat';
  rootId: string;
  path: string;
}
export interface FsThumbRequest {
  op: 'thumb';
  rootId: string;
  path: string;
  size?: FsThumbSize;
}
export interface FsMkdirRequest {
  op: 'mkdir';
  requestId: string;
  rootId: string;
  /** Pasta onde criar. */
  path: string;
  name: string;
}
export interface FsRenameRequest {
  op: 'rename';
  requestId: string;
  rootId: string;
  path: string;
  newName: string;
}
export interface FsMoveRequest {
  op: 'move';
  requestId: string;
  rootId: string;
  paths: string[];
  /** Raiz de destino (padrão: a mesma). Volumes diferentes → `CROSS_DEVICE`. */
  toRootId?: string;
  /** Pasta de destino. */
  toPath: string;
  /** `fail` (padrão), `rename` (` (2)`) ou `skip`. `replace` não é aceito em `move`. */
  onConflict?: Exclude<FsConflictPolicy, 'replace'>;
}
export interface FsTrashRequest {
  op: 'trash';
  requestId: string;
  rootId: string;
  paths: string[];
}
/** Só remoto: o PC prepara um blob cifrado com o conteúdo (§10.7). */
export interface FsDownloadRequest {
  op: 'download';
  rootId: string;
  path: string;
}
/** Só remoto: o celular já mandou o blob cifrado para a API; o PC baixa, confere e grava (§10.7). */
export interface FsUploadCommitRequest {
  op: 'upload';
  requestId: string;
  rootId: string;
  /** Pasta de destino. */
  path: string;
  name: string;
  /** `rename` (padrão), `replace` (o antigo vai para a Lixeira) ou `fail`. */
  onConflict?: Exclude<FsConflictPolicy, 'skip'>;
  blobId: string;
  /** Sal do blob (base64url, 16 bytes), gerado por quem cifrou. */
  blobSalt: string;
  /** Tamanho do arquivo em texto claro. */
  size: number;
  /** SHA-256 (hex) do arquivo em texto claro. */
  sha256: string;
}
/** Só remoto: estado de um `upload` que respondeu `pending`. */
export interface FsUploadStatusRequest {
  op: 'uploadStatus';
  blobId: string;
}

/** §11: arquivos que o PC ofereceu a este celular. */
export interface FsOutboxListRequest {
  op: 'outboxList';
}
/** §11, só remoto: como `download`, mas só alcança itens da caixa de saída deste celular. Na LAN há rota própria. */
export interface FsOutboxDownloadRequest {
  op: 'outboxDownload';
  id: string;
}
/** §11: "recebi e gravei". Idempotente. */
export interface FsOutboxDoneRequest {
  op: 'outboxDone';
  id: string;
}
/** §11: "não quero". Idempotente. Em item `changed` ou `failed`, só tira o aviso do celular. */
export interface FsOutboxDeclineRequest {
  op: 'outboxDecline';
  id: string;
}

export type FsRequest =
  | FsRootsRequest
  | FsListRequest
  | FsStatRequest
  | FsThumbRequest
  | FsMkdirRequest
  | FsRenameRequest
  | FsMoveRequest
  | FsTrashRequest
  | FsDownloadRequest
  | FsUploadCommitRequest
  | FsUploadStatusRequest
  | FsOutboxListRequest
  | FsOutboxDownloadRequest
  | FsOutboxDoneRequest
  | FsOutboxDeclineRequest;

export type FsOp = FsRequest['op'];
export const FS_OPS: readonly FsOp[] = [
  'roots',
  'list',
  'stat',
  'thumb',
  'mkdir',
  'rename',
  'move',
  'trash',
  'download',
  'upload',
  'uploadStatus',
  'outboxList',
  'outboxDownload',
  'outboxDone',
  'outboxDecline',
];
/**
 * Operações da caixa de saída (§11). Independem do interruptor "Acesso pelo celular": o usuário escolheu o arquivo de
 * forma explícita, e o pedido só leva o `id` do item, nunca um caminho.
 */
export const FS_OUTBOX_OPS: readonly FsOp[] = ['outboxList', 'outboxDownload', 'outboxDone', 'outboxDecline'];
/** Operações que mudam o disco: exigem `requestId`, são idempotentes por ele e entram na auditoria do PC. */
export const FS_MUTATING_OPS: readonly FsOp[] = ['mkdir', 'rename', 'move', 'trash', 'upload'];
/** Só existem no transporte remoto (na LAN há rotas de conteúdo próprias). */
export const FS_REMOTE_ONLY_OPS: readonly FsOp[] = ['download', 'upload', 'uploadStatus', 'outboxDownload'];

// ----- respostas -----

export interface FsRootsResponse {
  roots: FsRootInfo[];
  /** Nome do PC (para o cabeçalho da aba). */
  pcName: string;
  platform: FsPlatform;
}
export interface FsListResponse {
  rootId: string;
  path: string;
  entries: FsEntry[];
  nextCursor: string | null;
  /** Itens listáveis na pasta (depois dos filtros), para "1–200 de 1.350". */
  total: number;
  /** Itens escondidos por regra (bloqueados, link para fora da raiz, nome que o celular não consegue usar). */
  omitted: number;
}
export interface FsStatResponse {
  rootId: string;
  path: string;
  entry: FsEntry;
}
/** Remoto: a miniatura vem dentro da resposta cifrada. Na LAN a rota devolve o JPEG direto. */
export interface FsThumbResponse {
  mime: 'image/jpeg';
  width: number;
  height: number;
  /** JPEG em base64 padrão. */
  dataB64: string;
  etag: string;
}
export interface FsEntryResponse {
  rootId: string;
  /** Caminho (novo) do item. */
  path: string;
  entry: FsEntry;
}
export interface FsMkdirResponse extends FsEntryResponse {
  /** `false` = a pasta já existia (idempotente). */
  created: boolean;
}
export type FsBatchItemResult =
  | { path: string; ok: true; newPath: string | null; skipped?: boolean }
  | { path: string; ok: false; error: FsErrorBody };
export interface FsBatchResponse {
  results: FsBatchItemResult[];
}
export interface FsDownloadPrepared {
  blobId: string;
  /** base64url, 16 bytes: entra na derivação da chave do blob. */
  blobSalt: string;
  name: string;
  size: number;
  mime: string | null;
  mtime: string;
  cipherSize: number;
  etag: string;
}
export interface FsUploadResult {
  rootId: string;
  /** Caminho final (pode ter ` (2)`). */
  path: string;
  entry: FsEntry;
  verifiedHash: string;
  /** O nome mudou por colisão. */
  renamed: boolean;
}
export type FsUploadState = 'pending' | 'done' | 'failed';
export interface FsUploadStatusResponse {
  blobId: string;
  status: FsUploadState;
  /** Bytes de texto claro já gravados no PC (progresso). */
  received: number;
  result?: FsUploadResult;
  error?: FsErrorBody;
}

/**
 * Estado de um item da caixa de saída (§11): `waiting` e `downloading` são ativos; `delivered`, `declined`, `changed`
 * (o tamanho ou a data do arquivo mudaram depois da escolha), `expired` e `failed` são finais.
 */
export type FsOutboxState = 'waiting' | 'downloading' | 'delivered' | 'declined' | 'changed' | 'expired' | 'failed';

/** O que o celular vê de um item. O caminho absoluto nunca sai do PC. */
export interface FsOutboxItem {
  /** `randomFsId()` gerado no PC. */
  id: string;
  name: string;
  size: number;
  mime: string | null;
  /** Última modificação do arquivo no momento da escolha, ISO 8601 UTC. */
  mtime: string;
  state: FsOutboxState;
  createdAt: string;
  expiresAt: string;
  /** Motivo, em `failed` (pt-BR). */
  reason?: string;
}
export interface FsOutboxListResponse {
  /** Itens deste celular: ativos e os `changed`/`failed` que ele ainda não dispensou. */
  items: FsOutboxItem[];
  pcName: string;
}
/** Resposta de `outboxDone` e `outboxDecline`: o estado atual do item. */
export interface FsOutboxItemResponse {
  item: FsOutboxItem;
}

/** Texto claro de uma resposta remota (dentro do envelope `typ: 'res'`). */
export type FsRpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: FsErrorBody };

// ----- eventos E2E (PC → celulares, `fs.event`, envelope `typ: 'evt'`) -----
export type FsEvent =
  | { kind: 'rootsChanged' }
  /** §11: a caixa de saída de `phoneId` mudou. Só o id do celular, sem nome: o evento vai para todos os celulares da conta. */
  | { kind: 'outboxChanged'; phoneId: string }
  | { kind: 'uploadDone'; blobId: string; result: FsUploadResult }
  | { kind: 'uploadFailed'; blobId: string; error: FsErrorBody }
  | { kind: 'downloadFailed'; blobId: string; error: FsErrorBody };

// ----- blobs na API (metadados em texto claro; o conteúdo é cifrado) -----
export type FsBlobDirection = 'toPc' | 'toPhone';
export type FsBlobStatus = 'uploading' | 'ready' | 'downloading' | 'done' | 'failed' | 'expired';
/** `POST /v1/fs-blobs` */
export interface CreateFsBlobRequest {
  /** Obrigatório quando quem cria é o celular (blob `toPc`). */
  pcDeviceId?: string;
  /** Tamanho do blob cifrado (`fsBlobCipherSize(tamanho do arquivo)`). */
  cipherSize: number;
}
export interface FsBlobInfo {
  id: string;
  pcDeviceId: string;
  direction: FsBlobDirection;
  status: FsBlobStatus;
  cipherSize: number;
  bytesReceived: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

// ----- auditoria local no PC (§10.10) -----
export interface FsAuditEntry {
  id: string;
  at: string;
  phoneId: string;
  phoneName: string | null;
  via: 'lan' | 'remote';
  op: FsOp | 'browse';
  rootId: string | null;
  rootLabel: string | null;
  /** Caminhos em texto claro: o registro fica só no PC do usuário. */
  path: string | null;
  toPath: string | null;
  count: number;
  bytes: number | null;
  result: 'ok' | FsErrorCode;
}

// =====================================================================================
// Erros
// =====================================================================================

export type FsErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_NAME'
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'IS_A_DIRECTORY'
  | 'FORBIDDEN_PATH'
  | 'PERMISSION_DENIED'
  | 'ROOT_REMOVED'
  | 'ROOT_UNAVAILABLE'
  | 'FS_DISABLED'
  | 'CONFLICT'
  | 'HASH_MISMATCH'
  | 'CHANGED'
  | 'INVALID_MOVE'
  | 'CROSS_DEVICE'
  | 'TRASH_UNAVAILABLE'
  | 'NO_THUMBNAIL'
  | 'NO_SPACE'
  | 'TOO_LARGE'
  | 'BUSY'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_OP'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INTERNAL';

export interface FsErrorBody {
  code: FsErrorCode;
  message: string;
}

/** Status HTTP de cada código nas rotas `/v1/fs/*` da LAN (no remoto o código vai dentro do envelope). */
export const FS_ERROR_STATUS: Record<FsErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_NAME: 400,
  NOT_FOUND: 404,
  NOT_A_DIRECTORY: 400,
  IS_A_DIRECTORY: 400,
  FORBIDDEN_PATH: 403,
  PERMISSION_DENIED: 403,
  ROOT_REMOVED: 410,
  ROOT_UNAVAILABLE: 503,
  FS_DISABLED: 403,
  CONFLICT: 409,
  HASH_MISMATCH: 409,
  CHANGED: 409,
  INVALID_MOVE: 422,
  CROSS_DEVICE: 422,
  TRASH_UNAVAILABLE: 422,
  NO_THUMBNAIL: 404,
  NO_SPACE: 507,
  TOO_LARGE: 413,
  BUSY: 423,
  RATE_LIMITED: 429,
  UNSUPPORTED_OP: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

/**
 * Exceção de status no envio pela LAN (`PUT /v1/fs/upload/:id`): conflito de nome com `onConflict=fail` responde
 * `412` (código `CONFLICT`), porque `409` no envio em pedaços significa sempre "hash diferente" (§4.1).
 */
export const FS_UPLOAD_NAME_CONFLICT_STATUS = 412;

/** Mensagens padrão (pt-BR) para o celular mostrar. */
export const FS_ERROR_MESSAGES: Record<FsErrorCode, string> = {
  VALIDATION_ERROR: 'Pedido inválido.',
  INVALID_NAME: 'Esse nome não pode ser usado.',
  NOT_FOUND: 'Este item não existe mais no PC.',
  NOT_A_DIRECTORY: 'Isso não é uma pasta.',
  IS_A_DIRECTORY: 'Isso é uma pasta, não um arquivo.',
  FORBIDDEN_PATH: 'Esta pasta não pode ser acessada pelo celular.',
  PERMISSION_DENIED: 'O Windows não deixou o Arkivo mexer neste item.',
  ROOT_REMOVED: 'Esta pasta deixou de ser liberada no PC.',
  ROOT_UNAVAILABLE: 'A unidade desta pasta está desconectada do PC.',
  FS_DISABLED: 'O acesso pelo celular está desligado no PC.',
  CONFLICT: 'Já existe um item com esse nome.',
  HASH_MISMATCH: 'O arquivo chegou diferente do original. Envie de novo.',
  CHANGED: 'O arquivo mudou no PC enquanto era preparado. Tente de novo.',
  INVALID_MOVE: 'Não dá para mover uma pasta para dentro dela mesma.',
  CROSS_DEVICE: 'Mover entre unidades diferentes ainda não é possível. Baixe e envie de novo.',
  TRASH_UNAVAILABLE: 'Esta unidade não tem Lixeira. Para apagar, use o próprio PC.',
  NO_THUMBNAIL: 'Sem prévia para este arquivo.',
  NO_SPACE: 'O PC está sem espaço livre.',
  TOO_LARGE: 'Arquivo grande demais para passar pela internet. Ele vai quando estiver na mesma rede do PC.',
  BUSY: 'O PC está ocupado com este item. Tente de novo em instantes.',
  RATE_LIMITED: 'Muitos pedidos seguidos. Espere um pouco.',
  UNSUPPORTED_OP: 'O Arkivo do PC precisa ser atualizado para fazer isso.',
  UNAUTHORIZED: 'Acesso recusado pelo PC.',
  FORBIDDEN: 'Este celular não tem acesso a este PC.',
  INTERNAL: 'Algo deu errado no PC. Tente de novo.',
};

export function fsError(code: FsErrorCode, message?: string): FsErrorBody {
  return { code, message: message ?? FS_ERROR_MESSAGES[code] };
}

// =====================================================================================
// Nomes e caminhos relativos (o que o celular manda)
// =====================================================================================

export type FsNameProblem = 'empty' | 'dot' | 'too_long' | 'invalid_char' | 'trailing_dot_space' | 'reserved' | 'arkivo_reserved';
export type FsNameCheck = { ok: true; name: string } | { ok: false; problem: FsNameProblem };

/**
 * Proibidos em qualquer segmento (`reference`): separadores, `:` (fluxos alternativos do NTFS, `C:`) e controles.
 * Nomes de entradas reais que tenham esses caracteres (possível no Linux/macOS) não são listados (`omitted`).
 */
// eslint-disable-next-line no-control-regex
const FS_REFERENCE_BAD = /[/\\:\u0000-\u001f]/;
/** Proibidos ao criar (portável para Windows): `< > " | ? *`, além dos de `reference` e DEL. */
const FS_CREATE_BAD = /[<>"|?*\u007f]/;
/** Nomes de dispositivo do Windows, com ou sem extensão (`CON`, `nul.txt`, `COM1`, `LPT¹`, `CONIN$`). */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/**
 * Valida e normaliza (NFC) um nome.
 * - `reference`: nome de algo que já existe (segmento de caminho). Regras mínimas para não sair da pasta.
 * - `create`: nome novo (`mkdir`, `rename`, `upload`). Regras do Windows valem em qualquer PC, para o arquivo
 *   poder ser copiado para qualquer sistema depois.
 */
export function checkFsName(input: string, mode: 'reference' | 'create' = 'create'): FsNameCheck {
  if (typeof input !== 'string') return { ok: false, problem: 'empty' };
  const name = input.normalize('NFC');
  if (!name) return { ok: false, problem: 'empty' };
  if (name === '.' || name === '..') return { ok: false, problem: 'dot' };
  if (utf8ByteLength(name) > FS_NAME_MAX_BYTES) return { ok: false, problem: 'too_long' };
  if (FS_REFERENCE_BAD.test(name)) return { ok: false, problem: 'invalid_char' };
  if (name.toLowerCase().startsWith(FS_RESERVED_PREFIX)) return { ok: false, problem: 'arkivo_reserved' };
  if (mode === 'reference') return { ok: true, name };
  if (FS_CREATE_BAD.test(name)) return { ok: false, problem: 'invalid_char' };
  if (!name.trim()) return { ok: false, problem: 'empty' };
  // O Windows remove ponto e espaço do fim sem avisar: dois nomes diferentes virariam o mesmo arquivo.
  if (/[. ]$/.test(name)) return { ok: false, problem: 'trailing_dot_space' };
  const base = name.split('.')[0].replace(/ +$/, '');
  if (WINDOWS_DEVICE_NAMES.test(base)) return { ok: false, problem: 'reserved' };
  return { ok: true, name };
}

export const FS_NAME_PROBLEM_MESSAGES: Record<FsNameProblem, string> = {
  empty: 'Digite um nome.',
  dot: 'Esse nome não pode ser usado.',
  too_long: 'Nome comprido demais.',
  invalid_char: 'O nome não pode ter estes caracteres: \\ / : * ? " < > |',
  trailing_dot_space: 'O nome não pode terminar com ponto ou espaço.',
  reserved: 'Esse nome é reservado pelo Windows.',
  arkivo_reserved: 'Nomes começando com ".arkivo-" são reservados.',
};

export type FsPathCheck =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; problem: 'absolute' | 'backslash' | 'empty_segment' | 'too_long' | 'too_deep' | FsNameProblem };

/**
 * Normaliza um caminho relativo à raiz: NFC, separador `/`, sem `/` no começo nem no fim, sem segmentos vazios,
 * `.` ou `..`, sem `\`, sem `C:`. `""` é a própria raiz. Cada segmento passa por `checkFsName(_, 'reference')`.
 */
export function normalizeFsPath(input: string): FsPathCheck {
  if (typeof input !== 'string') return { ok: false, problem: 'empty_segment' };
  const p = input.normalize('NFC');
  if (p === '') return { ok: true, path: '', segments: [] };
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { ok: false, problem: 'absolute' };
  if (p.includes('\\')) return { ok: false, problem: 'backslash' };
  if (utf8ByteLength(p) > FS_PATH_MAX_BYTES) return { ok: false, problem: 'too_long' };
  const segments = p.split('/');
  if (segments.length > FS_PATH_MAX_DEPTH) return { ok: false, problem: 'too_deep' };
  for (const s of segments) {
    if (s === '') return { ok: false, problem: 'empty_segment' };
    const c = checkFsName(s, 'reference');
    if (!c.ok) return { ok: false, problem: c.problem };
  }
  return { ok: true, path: p, segments };
}

/** `joinFsPath('Fotos/2026', 'a.jpg')` → `Fotos/2026/a.jpg`; `joinFsPath('', 'a')` → `a`. */
export function joinFsPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Pasta-mãe (`'a/b/c'` → `'a/b'`, `'a'` → `''`, `''` → `''`). */
export function fsParentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function fsBaseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * `descendant` é `ancestor` ou está dentro dele (caminhos já normalizados).
 * `caseInsensitive` para Windows/macOS. Usado para recusar mover uma pasta para dentro dela mesma.
 */
export function isFsPathInside(ancestor: string, descendant: string, caseInsensitive = false): boolean {
  const a = caseInsensitive ? ancestor.toLowerCase() : ancestor;
  const d = caseInsensitive ? descendant.toLowerCase() : descendant;
  if (a === '') return true;
  return d === a || d.startsWith(a + '/');
}

/** Sufixo de colisão, como o backup (§4 Organização): `foto.jpg` → `foto (2).jpg`; pasta `Fotos` → `Fotos (2)`. */
export function fsCollisionName(name: string, n: number, isDir = false): string {
  if (n <= 1) return name;
  const dot = isDir ? -1 : name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** Oculto pela convenção do nome (o PC também marca o atributo "oculto" do Windows). */
export function isFsHiddenName(name: string): boolean {
  return name.startsWith('.') || FS_LIST_IGNORED_NAMES.includes(name.toLowerCase());
}

// =====================================================================================
// MIME e miniaturas
// =====================================================================================

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  webm: 'video/webm', '3gp': 'video/3gpp', wmv: 'video/x-ms-wmv', mts: 'video/mp2t',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', rtf: 'application/rtf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tar: 'application/x-tar',
  apk: 'application/vnd.android.package-archive', epub: 'application/epub+zip',
};

/** MIME pela extensão (minúscula). Desconhecido → `application/octet-stream`. */
export function fsMimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'application/octet-stream';
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Tipos para os quais o PC tenta miniatura. SVG fica de fora (pode carregar conteúdo externo).
 * Vídeo e HEIC dependem do SO (miniaturas do Explorer/Quick Look); o PC confirma em `hasThumb`.
 */
export function fsThumbCandidate(mime: string | null): boolean {
  if (!mime) return false;
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/pdf';
}

// =====================================================================================
// Ordenação (pastas sempre primeiro)
// =====================================================================================

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** Ordem da listagem: pastas primeiro; desempate sempre por nome (natural, sem diferenciar maiúsculas e acentos). */
export function compareFsEntries(a: FsEntry, b: FsEntry, sort: FsSortKey = 'name', order: FsSortOrder = 'asc'): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  const dir = order === 'desc' ? -1 : 1;
  let c = 0;
  if (sort === 'mtime') c = Date.parse(a.mtime) - Date.parse(b.mtime);
  else if (sort === 'size') c = (a.size ?? 0) - (b.size ?? 0);
  else if (sort === 'type') c = collator.compare(a.mime ?? '', b.mime ?? '');
  if (c === 0) c = collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return c * dir;
}

// =====================================================================================
// LAN: query canônica e texto assinado das rotas /v1/fs/* (§10.5)
// =====================================================================================

/** Prefixo do texto assinado das rotas `/v1/fs/*` (separa do texto do backup, §3.3). */
export const LAN_FS_SIG_PREFIX = `ARKIVO-FS-${FS_PROTOCOL_VERSION}`;
/** Cabeçalho do nonce (16 bytes aleatórios em base64url), obrigatório nas rotas `/v1/fs/*`. */
export const LAN_FS_NONCE_HEADER = 'x-arkivo-nonce';
export const LAN_FS_NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** `encodeURIComponent` estrito (RFC 3986): também codifica `!'()*`. */
export function fsEncodeComponent(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Query canônica: chaves em ordem (por unidade de código), `chave=valor` com `fsEncodeComponent` nos dois,
 * separados por `&`; parâmetros `undefined`/`null` ficam de fora. Sem `?`. É o que vai na URL **e** no texto
 * assinado; o PC recalcula a partir da query que recebeu (`parseFsQuery` + `canonicalFsQuery`), então um
 * cliente HTTP que recodifique a URL não quebra a assinatura.
 */
export function canonicalFsQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${fsEncodeComponent(k)}=${fsEncodeComponent(String(params[k]))}`)
    .join('&');
}

/**
 * Lê a query (com ou sem `?`). `+` vira espaço (como `URLSearchParams`). Chave repetida ou
 * percent-encoding inválido → `null` (o PC responde `400`).
 */
export function parseFsQuery(raw: string): Record<string, string> | null {
  const q = raw.startsWith('?') ? raw.slice(1) : raw;
  const out: Record<string, string> = {};
  if (!q) return out;
  for (const part of q.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rk = eq < 0 ? part : part.slice(0, eq);
    const rv = eq < 0 ? '' : part.slice(eq + 1);
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent(rk.replace(/\+/g, ' '));
      v = decodeURIComponent(rv.replace(/\+/g, ' '));
    } catch {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(out, k)) return null;
    out[k] = v;
  }
  return out;
}

export interface LanFsSignatureInput {
  method: string;
  /** Só o caminho, como vai na linha da requisição (percent-encoding do cliente), sem host e sem query. */
  path: string;
  /** Saída de `canonicalFsQuery` (vazio se não há query). */
  query: string;
  /** Mesmo valor de `X-Arkivo-Ts`. */
  ts: string | number;
  /** Mesmo valor de `X-Arkivo-Nonce`. */
  nonce: string;
  /**
   * `POST`: SHA-256 (hex) dos bytes do corpo. `PUT` de envio: o `X-Arkivo-Hash` (arquivo inteiro), como no §3.3.
   * `GET`/`HEAD`/`DELETE`: vazio.
   */
  bodySha256?: string;
}

/**
 * Texto canônico assinado com HMAC-SHA256(pairKey) nas rotas `/v1/fs/*` (§10.5):
 * `ARKIVO-FS-1\nMETHOD\nPATH\nQUERY\nTS\nNONCE\nBODY_SHA256` (UTF-8, sem `\n` no fim).
 */
export function lanFsSignaturePayload(i: LanFsSignatureInput): string {
  return [LAN_FS_SIG_PREFIX, i.method.toUpperCase(), i.path, i.query, String(i.ts), i.nonce, (i.bodySha256 ?? '').toLowerCase()].join('\n');
}

// =====================================================================================
// LAN: rotas e parâmetros
// =====================================================================================

export const FS_LAN_ROUTES = {
  roots: '/v1/fs/roots',
  list: '/v1/fs/list',
  stat: '/v1/fs/stat',
  thumb: '/v1/fs/thumb',
  download: '/v1/fs/download',
  /** `+ '/' + encodeURIComponent(uploadId)` */
  upload: '/v1/fs/upload',
  mkdir: '/v1/fs/mkdir',
  rename: '/v1/fs/rename',
  move: '/v1/fs/move',
  trash: '/v1/fs/trash',
  // §11
  outbox: '/v1/fs/outbox',
  outboxDownload: '/v1/fs/outbox/download',
  outboxDone: '/v1/fs/outbox/done',
  outboxDecline: '/v1/fs/outbox/decline',
} as const;

/** Parâmetros de query de `GET /v1/fs/list` a partir do pedido (para montar a URL e assinar). */
export function fsListQuery(r: Omit<FsListRequest, 'op'>): Record<string, string | number | boolean | undefined> {
  return {
    rootId: r.rootId,
    path: r.path,
    cursor: r.cursor,
    limit: r.limit,
    sort: r.sort,
    order: r.order,
    includeHidden: r.includeHidden === undefined ? undefined : r.includeHidden ? 1 : 0,
  };
}

// =====================================================================================
// Validação de pedidos (o PC usa nas duas vias: corpo/query da LAN e texto claro do envelope)
// =====================================================================================

export type FsParseResult = { ok: true; request: FsRequest } | { ok: false; error: FsErrorBody };

const HEX64 = /^[0-9a-f]{64}$/;
const SORT_KEYS: readonly FsSortKey[] = ['name', 'mtime', 'size', 'type'];

class FsParseError extends Error {
  constructor(readonly body: FsErrorBody) {
    super(body.message);
  }
}

function bad(code: FsErrorCode, message: string): never {
  throw new FsParseError(fsError(code, message));
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') bad('VALIDATION_ERROR', `${k}: obrigatório.`);
  return v;
}

function optStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') bad('VALIDATION_ERROR', `${k}: texto esperado.`);
  return v;
}

/** Aceita número ou texto decimal (a query da LAN chega como texto). */
function optInt(o: Record<string, unknown>, k: string, min: number, max: number): number | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) bad('VALIDATION_ERROR', `${k}: inteiro entre ${min} e ${max}.`);
  return n;
}

function optBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 'true' || v === '1' || v === 1) return true;
  if (v === false || v === 'false' || v === '0' || v === 0) return false;
  bad('VALIDATION_ERROR', `${k}: verdadeiro ou falso.`);
}

function rootId(o: Record<string, unknown>, k = 'rootId'): string {
  const v = str(o, k);
  if (!FS_ROOT_ID_RE.test(v)) bad('VALIDATION_ERROR', `${k}: inválido.`);
  return v;
}

function clientId(o: Record<string, unknown>, k: string): string {
  const v = str(o, k);
  if (!FS_CLIENT_ID_RE.test(v)) bad('VALIDATION_ERROR', `${k}: inválido.`);
  return v;
}

function relPath(o: Record<string, unknown>, k = 'path'): string {
  const v = o[k] === undefined ? '' : str(o, k);
  const c = normalizeFsPath(v);
  if (!c.ok) bad('FORBIDDEN_PATH', `${k}: caminho inválido (${c.problem}).`);
  return c.path;
}

function newName(o: Record<string, unknown>, k: string): string {
  const c = checkFsName(str(o, k), 'create');
  if (!c.ok) bad('INVALID_NAME', FS_NAME_PROBLEM_MESSAGES[c.problem]);
  return c.name;
}

function pathList(o: Record<string, unknown>): string[] {
  const v = o.paths;
  if (!Array.isArray(v) || v.length === 0 || v.length > FS_BATCH_MAX) bad('VALIDATION_ERROR', `paths: de 1 a ${FS_BATCH_MAX} itens.`);
  const out = v.map((p, i) => {
    if (typeof p !== 'string') bad('VALIDATION_ERROR', `paths[${i}]: texto esperado.`);
    const c = normalizeFsPath(p);
    if (!c.ok) bad('FORBIDDEN_PATH', `paths[${i}]: caminho inválido (${c.problem}).`);
    if (c.path === '') bad('FORBIDDEN_PATH', 'A pasta liberada em si não pode ser movida nem apagada.');
    return c.path;
  });
  if (new Set(out).size !== out.length) bad('VALIDATION_ERROR', 'paths: itens repetidos.');
  return out;
}

function oneOf<T extends string>(o: Record<string, unknown>, k: string, allowed: readonly T[]): T | undefined {
  const v = optStr(o, k);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) bad('VALIDATION_ERROR', `${k}: use ${allowed.join(', ')}.`);
  return v as T;
}

/**
 * Valida e normaliza um pedido (`op` + parâmetros). Caminhos saem em NFC; nomes novos passam pelas regras de criação.
 * Não toca no disco: raiz desconhecida, bloqueio do sistema e links são conferidos pelo PC depois.
 * `op` desconhecida → `UNSUPPORTED_OP` (celular mais novo que o PC).
 */
export function parseFsRequest(input: unknown): FsParseResult {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('VALIDATION_ERROR', 'Pedido inválido.');
    const o = input as Record<string, unknown>;
    const op = o.op;
    if (typeof op !== 'string') bad('VALIDATION_ERROR', 'op: obrigatório.');
    switch (op) {
      case 'roots':
        return { ok: true, request: { op } };
      case 'list': {
        const r: FsListRequest = { op, rootId: rootId(o), path: relPath(o) };
        const cursor = optStr(o, 'cursor');
        if (cursor !== undefined) {
          if (cursor.length > 512) bad('VALIDATION_ERROR', 'cursor: inválido.');
          r.cursor = cursor;
        }
        const limit = optInt(o, 'limit', 1, FS_LIST_MAX_LIMIT);
        if (limit !== undefined) r.limit = limit;
        const sort = oneOf(o, 'sort', SORT_KEYS);
        if (sort) r.sort = sort;
        const order = oneOf(o, 'order', ['asc', 'desc'] as const);
        if (order) r.order = order;
        const hidden = optBool(o, 'includeHidden');
        if (hidden !== undefined) r.includeHidden = hidden;
        return { ok: true, request: r };
      }
      case 'stat':
      case 'download':
        return { ok: true, request: { op, rootId: rootId(o), path: relPath(o) } };
      case 'thumb': {
        const r: FsThumbRequest = { op, rootId: rootId(o), path: relPath(o) };
        const size = optInt(o, 'size', 1, 4096);
        if (size !== undefined) {
          if (!(FS_THUMB_SIZES as readonly number[]).includes(size)) bad('VALIDATION_ERROR', `size: use ${FS_THUMB_SIZES.join(', ')}.`);
          r.size = size as FsThumbSize;
        }
        return { ok: true, request: r };
      }
      case 'mkdir':
        return { ok: true, request: { op, requestId: clientId(o, 'requestId'), rootId: rootId(o), path: relPath(o), name: newName(o, 'name') } };
      case 'rename': {
        const path = relPath(o);
        if (path === '') bad('FORBIDDEN_PATH', 'A pasta liberada em si só pode ser renomeada no PC.');
        return { ok: true, request: { op, requestId: clientId(o, 'requestId'), rootId: rootId(o), path, newName: newName(o, 'newName') } };
      }
      case 'move': {
        const r: FsMoveRequest = { op, requestId: clientId(o, 'requestId'), rootId: rootId(o), paths: pathList(o), toPath: relPath(o, 'toPath') };
        if (o.toRootId !== undefined) r.toRootId = rootId(o, 'toRootId');
        const pol = oneOf(o, 'onConflict', ['fail', 'rename', 'skip'] as const);
        if (pol) r.onConflict = pol;
        return { ok: true, request: r };
      }
      case 'trash':
        return { ok: true, request: { op, requestId: clientId(o, 'requestId'), rootId: rootId(o), paths: pathList(o) } };
      case 'upload': {
        const sha = str(o, 'sha256').toLowerCase();
        if (!HEX64.test(sha)) bad('VALIDATION_ERROR', 'sha256: hex de 64 caracteres.');
        const size = optInt(o, 'size', 0, Number.MAX_SAFE_INTEGER);
        if (size === undefined) bad('VALIDATION_ERROR', 'size: obrigatório.');
        const r: FsUploadCommitRequest = {
          op,
          requestId: clientId(o, 'requestId'),
          rootId: rootId(o),
          path: relPath(o),
          name: newName(o, 'name'),
          blobId: blobIdOf(o),
          blobSalt: saltOf(o),
          size,
          sha256: sha,
        };
        const pol = oneOf(o, 'onConflict', ['fail', 'rename', 'replace'] as const);
        if (pol) r.onConflict = pol;
        return { ok: true, request: r };
      }
      case 'uploadStatus':
        return { ok: true, request: { op, blobId: blobIdOf(o) } };
      case 'outboxList':
        return { ok: true, request: { op } };
      case 'outboxDownload':
      case 'outboxDone':
      case 'outboxDecline':
        return { ok: true, request: { op, id: clientId(o, 'id') } };
      default:
        bad('UNSUPPORTED_OP', `Operação desconhecida: ${op.slice(0, 32)}`);
    }
  } catch (e) {
    if (e instanceof FsParseError) return { ok: false, error: e.body };
    throw e;
  }
}

function blobIdOf(o: Record<string, unknown>): string {
  const v = str(o, 'blobId');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) bad('VALIDATION_ERROR', 'blobId: inválido.');
  return v;
}

function saltOf(o: Record<string, unknown>): string {
  const v = str(o, 'blobSalt');
  if (!/^[A-Za-z0-9_-]{22}$/.test(v)) bad('VALIDATION_ERROR', 'blobSalt: 16 bytes em base64url.');
  return v;
}

// =====================================================================================
// Bloqueio de pastas do sistema (§10.2). Puro: o PC passa caminhos absolutos já resolvidos com `realpath`.
// =====================================================================================

/**
 * `filesystem-root`: a raiz `/` do macOS/Linux (só ao escolher raiz). `other-profile` [2026-11-06]: a pasta de outro
 * usuário do Windows (`C:\Users\<outro>`), que fica ao alcance quando a unidade inteira é liberada.
 */
export type FsBlockReason = 'filesystem-root' | 'system' | 'app-data' | 'other-profile' | 'credentials' | 'arkivo-internal';

export interface FsSystemContext {
  platform: FsPlatform;
  /** `os.homedir()` */
  home: string;
  /** Windows: `%SystemDrive%` (padrão `C:`). */
  systemDrive?: string;
  /** Windows: `%SystemRoot%` (padrão `<systemDrive>\Windows`). */
  windowsDir?: string;
  /** Windows: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`. */
  programFiles?: string[];
  /** Windows: `%ProgramData%`. */
  programData?: string;
  /** Pastas extras sempre bloqueadas (ex.: `app.getPath('userData')` do Arkivo). */
  extraBlocked?: string[];
}

/** Credenciais e chaves: bloqueadas em qualquer lugar, em qualquer SO. */
const CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store'];
/** Windows: primeiro nível de **qualquer** unidade. */
const WIN_DRIVE_LEVEL_DIRS = [
  'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'recycler', 'system volume information',
  'recovery', '$winreagent', 'config.msi', '$sysreset', '$windows.~bt', '$windows.~ws', 'windows.old', 'boot',
  'documents and settings', 'msocache', '$getcurrent', 'onedrivetemp', 'perflogs',
  // [2026-11-06] Com a unidade do sistema liberada inteira: a junção "Arquivos de Programas" do Windows em português
  // (o `realpath` já cai em Program Files; o nome fica aqui para a checagem pelo nome recusar também) e o IIS.
  'arquivos de programas', 'arquivos de programas (x86)', 'inetpub',
];
const WIN_DRIVE_LEVEL_FILES = [
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp', 'bootmgr', 'bootnxt', 'bootsect.bak',
];
/** Perfil compartilhado: fica liberado (os outros perfis não, §10.2). */
const WIN_PROFILE_SHARED = 'public';
const WIN_PROFILE_SYSTEM = ['default', 'default user', 'all users', 'defaultapppool'];
const MAC_SYSTEM_TOP = ['system', 'library', 'private', 'usr', 'bin', 'sbin', 'etc', 'var', 'tmp', 'cores', 'dev', 'opt', 'applications', 'network'];
const MAC_SYSTEM_ANY = ['.trash', '.trashes', '.spotlight-v100', '.fseventsd', '.documentrevisions-v100', '.temporaryitems'];
const LINUX_SYSTEM_TOP = ['bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'usr', 'var', 'snap', 'tmp', 'opt', 'lost+found'];
const LINUX_HOME_APPDATA = ['.config', '.local', '.cache', 'snap', '.var'];

interface AbsPath {
  /** Windows: `c:` ou `\\servidor\compartilhamento` (minúsculo); POSIX: `''`. */
  drive: string;
  /** Segmentos (minúsculos no Windows/macOS). */
  segments: string[];
}

/** Normaliza um caminho absoluto para comparação. `null` se não for absoluto. */
export function parseAbsPath(abs: string, platform: FsPlatform): AbsPath | null {
  let p = String(abs ?? '').normalize('NFC');
  const fold = platform !== 'linux';
  if (platform === 'windows') {
    p = p.replace(/\//g, '\\');
    if (p.startsWith('\\\\?\\UNC\\')) p = '\\\\' + p.slice(8);
    else if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) p = p.slice(4);
    let drive: string;
    let rest: string;
    const m = /^([A-Za-z]:)(\\|$)(.*)$/.exec(p);
    if (m) {
      drive = m[1];
      rest = m[3];
    } else {
      const u = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(p);
      if (!u) return null;
      drive = `\\\\${u[1]}\\${u[2]}`;
      rest = u[3] ?? '';
    }
    const segments = rest.split('\\').filter((s) => s && s !== '.');
    if (segments.includes('..')) return null;
    return { drive: drive.toLowerCase(), segments: segments.map((s) => s.toLowerCase()) };
  }
  if (!p.startsWith('/')) return null;
  const segments = p.split('/').filter((s) => s && s !== '.');
  if (segments.includes('..')) return null;
  return { drive: '', segments: fold ? segments.map((s) => s.toLowerCase()) : segments };
}

function startsWithPath(p: AbsPath, prefix: AbsPath | null): boolean {
  if (!prefix || p.drive !== prefix.drive || p.segments.length < prefix.segments.length) return false;
  return prefix.segments.every((s, i) => p.segments[i] === s);
}

/** `target` é `root` ou está dentro dele (caminhos absolutos já resolvidos com `realpath`). */
export function isAbsPathInside(root: string, target: string, platform: FsPlatform): boolean {
  const r = parseAbsPath(root, platform);
  const t = parseAbsPath(target, platform);
  return !!r && !!t && startsWithPath(t, r);
}

/** Duas raízes se sobrepõem (uma dentro da outra ou iguais): o PC recusa a segunda. */
export function fsRootsOverlap(a: string, b: string, platform: FsPlatform): boolean {
  return isAbsPathInside(a, b, platform) || isAbsPathInside(b, a, platform);
}

/**
 * Motivo de bloqueio de um caminho absoluto (raiz ou qualquer coisa alcançada dentro dela); `null` = liberado.
 * Não bloqueia a raiz de unidade (isso só vale para escolher raiz: `fsRootRejectReason`).
 */
export function fsBlockedReason(abs: string, ctx: FsSystemContext): FsBlockReason | null {
  const p = parseAbsPath(abs, ctx.platform);
  if (!p) return 'system';
  const seg = p.segments;
  const lower = seg.map((s) => s.toLowerCase());
  if (lower.some((s) => s.startsWith(FS_RESERVED_PREFIX))) return 'arkivo-internal';
  for (const extra of ctx.extraBlocked ?? []) if (startsWithPath(p, parseAbsPath(extra, ctx.platform))) return 'arkivo-internal';
  if (lower.some((s) => CREDENTIAL_DIRS.includes(s))) return 'credentials';

  const home = parseAbsPath(ctx.home, ctx.platform);
  const underHome = (names: string[]): boolean =>
    !!home && startsWithPath(p, home) && seg.length > home.segments.length && names.includes(lower[home.segments.length]);

  if (ctx.platform === 'windows') {
    const sys = (ctx.systemDrive ?? 'C:').replace(/\\$/, '');
    const fixed = [ctx.windowsDir ?? `${sys}\\Windows`, ctx.programData ?? `${sys}\\ProgramData`, ...(ctx.programFiles ?? [`${sys}\\Program Files`, `${sys}\\Program Files (x86)`])];
    for (const f of fixed) if (startsWithPath(p, parseAbsPath(f, 'windows'))) return 'system';
    if (seg.length >= 1 && WIN_DRIVE_LEVEL_DIRS.includes(lower[0])) return 'system';
    if (seg.length === 1 && WIN_DRIVE_LEVEL_FILES.includes(lower[0])) return 'system';
    if (seg.length >= 2 && lower[0] === 'users') {
      if (WIN_PROFILE_SYSTEM.includes(lower[1])) return 'system';
      if (seg.length >= 3 && lower[2] === 'appdata') return 'app-data';
      if (seg.length === 3 && /^(ntuser|usrclass)\./.test(lower[2])) return 'system';
    }
    if (underHome(['appdata'])) return 'app-data';
    // Perfis de outros usuários: `<pasta de perfis>\<outro>`, onde a pasta de perfis é a `Users` que contém `home`.
    if (home && home.segments.length >= 2 && home.segments[home.segments.length - 2] === 'users') {
      const n = home.segments.length - 1;
      const profiles: AbsPath = { drive: home.drive, segments: home.segments.slice(0, n) };
      if (seg.length > n && startsWithPath(p, profiles) && lower[n] !== home.segments[n] && lower[n] !== WIN_PROFILE_SHARED)
        return 'other-profile';
    }
    return null;
  }
  if (ctx.platform === 'macos') {
    if (seg.length >= 1 && MAC_SYSTEM_TOP.includes(lower[0])) return 'system';
    if (lower.some((s) => MAC_SYSTEM_ANY.includes(s))) return 'system';
    if (underHome(['library'])) return 'app-data';
    // /Volumes/<sistema> aponta para "/": o realpath já resolve; aqui só o caso de quem passa o caminho cru.
    return null;
  }
  // linux (diferencia maiúsculas)
  if (seg.length >= 1 && LINUX_SYSTEM_TOP.includes(seg[0])) return 'system';
  if (lower.some((s) => /^\.trash(-\d+)?$/.test(s)) || seg.includes('lost+found')) return 'system';
  if (underHome(LINUX_HOME_APPDATA)) return 'app-data';
  return null;
}

/**
 * A pasta é a raiz de uma unidade do Windows (`C:\`, `E:\`; compartilhamento `\\nas\fotos` não conta). Liberar uma
 * delas é "liberar a unidade inteira" (§10.2 [2026-11-06]).
 */
export function isFsDriveRoot(abs: string, platform: FsPlatform): boolean {
  if (platform !== 'windows') return false;
  const p = parseAbsPath(abs, platform);
  return !!p && /^[a-z]:$/.test(p.drive) && p.segments.length === 0;
}

/** Letra da unidade (`"C:"`) de um caminho do Windows; `null` em compartilhamento de rede e fora do Windows. */
export function fsDriveLetter(abs: string, platform: FsPlatform): string | null {
  if (platform !== 'windows') return null;
  const p = parseAbsPath(abs, platform);
  return p && /^[a-z]:$/.test(p.drive) ? p.drive.toUpperCase() : null;
}

/**
 * Motivo para recusar uma pasta como **raiz** liberada; `null` = pode liberar.
 * Além de `fsBlockedReason`: a raiz `/` do macOS e do Linux não pode ser liberada inteira. No Windows **qualquer**
 * unidade pode, inclusive a do sistema (`C:\`) [2026-11-06]: as pastas do sistema, de programas, AppData, os outros
 * perfis e as credenciais continuam bloqueados por dentro, pela própria `fsBlockedReason`.
 */
export function fsRootRejectReason(abs: string, ctx: FsSystemContext): FsBlockReason | null {
  const p = parseAbsPath(abs, ctx.platform);
  if (!p) return 'system';
  if (p.segments.length === 0 && ctx.platform !== 'windows') return 'filesystem-root';
  return fsBlockedReason(abs, ctx);
}

export const FS_BLOCK_MESSAGES: Record<FsBlockReason, string> = {
  'filesystem-root': 'Não é possível liberar o disco inteiro do sistema. Escolha uma pasta dentro dele.',
  system: 'Esta pasta é do sistema e não pode ser liberada.',
  'app-data': 'Esta pasta guarda dados de programas e não pode ser liberada.',
  'other-profile': 'Esta pasta é de outro usuário deste PC e não pode ser liberada.',
  credentials: 'Esta pasta guarda chaves e senhas e não pode ser liberada.',
  'arkivo-internal': 'Esta pasta é de uso interno do Arkivo.',
};

/** Recusa ao escolher um arquivo para enviar ao celular (§11): os mesmos bloqueios, com o texto de "arquivo". */
export const FS_PUSH_BLOCK_MESSAGES: Record<FsBlockReason, string> = {
  'filesystem-root': 'Só arquivos podem ser enviados.',
  system: 'Este arquivo é do sistema e não pode ser enviado.',
  'app-data': 'Este arquivo guarda dados de programas e não pode ser enviado.',
  'other-profile': 'Este arquivo é de outro usuário deste PC e não pode ser enviado.',
  credentials: 'Este arquivo guarda chaves e senhas e não pode ser enviado.',
  'arkivo-internal': 'Este arquivo é de uso interno do Arkivo.',
};
