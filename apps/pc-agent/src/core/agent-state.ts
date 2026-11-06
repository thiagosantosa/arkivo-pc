// Tipos do estado observável do agente. Só tipos, sem imports de Node:
// o renderer também usa este arquivo (via preload/IPC).

export type TransferRoute = 'lan' | 'relay';

export interface ActivityEntry {
  id: string;
  at: string; // ISO
  fileId: string;
  name: string;
  /** `AAAA/MM/nome` com `/` (null em falhas). */
  relativePath: string | null;
  size: number;
  hash: string | null;
  route: TransferRoute;
  status: 'saved' | 'failed';
  /** Já existia idêntico na pasta (não conta de novo no mês). */
  duplicate?: boolean;
  error?: string;
  durationMs?: number;
  bytesTransferred?: number;
}

/**
 * `updateRequired`: a API recusou esta versão (HTTP 426 ou WS 4426, contrato §9). O agente para de
 * tentar (WebSocket, relay, pareamento e servidor LAN) e o renderer mostra "Atualize o Arkivo para PC".
 */
export type AgentPhase = 'loading' | 'folder' | 'pairing' | 'active' | 'updateRequired';

/** Detalhes mostrados na tela de atualização. */
export interface UpdateRequiredView {
  /** Versão mínima exigida pela API (`null` se ela não informou). */
  minVersion: string | null;
  /** Protocolo que a API fala. */
  protocol: number;
}

export interface ActiveTransferView {
  key: string;
  name: string;
  route: TransferRoute;
  received: number;
  total: number;
  phase: 'receiving' | 'verifying';
  /** Pasta de destino prevista (`AAAA/MM`). */
  folder: string;
}

export interface PairingView {
  status: 'idle' | 'creating' | 'waiting' | 'error' | 'claimed';
  qrDataUrl: string | null;
  /** Link `arkivo://pair?...` mostrado abaixo do QR, com botão "Copiar código". */
  link: string | null;
  /** Epoch ms em que o QR expira (o renderer faz a contagem regressiva). */
  expiresAt: number | null;
  error: string | null;
}

/** Uma pasta liberada como a tela "Pastas liberadas" mostra (o caminho absoluto só aparece no PC). */
export interface FsRootUiView {
  id: string;
  label: string;
  absPath: string;
  drive: string | null;
  available: boolean;
  trashAvailable: boolean;
  freeBytes: number | null;
  addedAt: string;
}

/** Uma linha de "O que o celular fez" (auditoria local, §10.10). */
export interface FsAuditUiEntry {
  id: string;
  at: string;
  phoneId: string;
  phoneName: string | null;
  via: 'lan' | 'remote';
  op: string;
  rootLabel: string | null;
  path: string | null;
  toPath: string | null;
  count: number;
  bytes: number | null;
  /** `ok` ou o código do erro. */
  result: string;
}

/** [2026-11-06] Uma unidade em "Unidades deste PC" (§10.13). */
export interface FsDriveUiView {
  /** Windows: a letra (`"C"`); macOS/Linux: o ponto de montagem. O renderer manda só isto de volta. */
  id: string;
  /** `"C:"` ou o nome do volume. */
  name: string;
  /** Raiz mostrada (`C:\`, `/Volumes/HD`). */
  path: string;
  /** Rótulo que a unidade inteira ganha ao ser liberada ("Disco local (C:)", "Windows (C:)", "Pen drive (E:)"). */
  label: string;
  volumeLabel: string | null;
  kind: 'fixed' | 'removable' | 'network' | 'cdrom' | 'other';
  /** "Disco interno", "Pen drive / HD externo", "Unidade de rede", "CD/DVD". */
  kindLabel: string;
  freeBytes: number | null;
  totalBytes: number | null;
  trashAvailable: boolean;
  /** A unidade do Windows (`%SystemDrive%`): liberar inteira mostra o aviso das pastas do sistema. */
  system: boolean;
  /** "Liberar inteira" existe (Windows); no macOS/Linux só "Escolher pasta…". */
  canAddWhole: boolean;
  /** A raiz que é esta unidade inteira, se liberada. */
  wholeRootId: string | null;
  /** Quantas pastas liberadas ficam nesta unidade (sem contar a unidade inteira). */
  rootsInside: number;
}

export interface FsUiState {
  /** Interruptor "Acesso pelo celular". */
  enabled: boolean;
  roots: FsRootUiView[];
  /** [2026-11-06] Unidades deste PC (atualizada pela tela a cada ~10 s e ao ganhar foco). */
  drives: FsDriveUiView[];
  /** Mais recentes primeiro (no máximo 200 na tela). */
  audit: FsAuditUiEntry[];
}

/** Um arquivo em "Enviar para o celular" (contrato §11). */
export interface OutboxUiItem {
  id: string;
  name: string;
  folder: string;
  size: number;
  state: 'waiting' | 'downloading' | 'delivered' | 'declined' | 'changed' | 'expired' | 'failed';
  /** De 0 a 1 enquanto baixa. */
  progress: number | null;
  phoneId: string;
  phoneName: string | null;
  via: 'lan' | 'remote' | null;
  createdAt: string;
  expiresAt: string;
  reason: string | null;
}

export interface AgentState {
  phase: AgentPhase;
  /** Preenchido quando `phase === 'updateRequired'`. */
  updateRequired: UpdateRequiredView | null;
  appVersion: string;
  platform: 'windows' | 'macos' | 'linux';
  pcName: string;
  /** Pasta configurada ou sugerida (no passo 1). */
  storageDir: string | null;
  freeBytes: number | null;
  autostart: boolean;
  /** Segredos guardados com o cofre do SO (safeStorage). */
  secretsProtected: boolean;
  pairing: PairingView | null;
  /** Aviso mostrado na tela do QR (ex.: "Celular desconectado deste PC..."). */
  note: string | null;
  account: { name: string; handle: string; email?: string } | null;
  serverConnected: boolean;
  lan: { listening: boolean; port: number; addresses: string[]; error: string | null };
  phones: { id: string; name: string; capabilities?: string[] }[];
  lastRoute: TransferRoute | null;
  lastActivityAt: string | null;
  active: ActiveTransferView[];
  /** Itens do relay esperando na fila do PC. */
  queued: number;
  /** Velocidade atual (bytes/s) enquanto recebe; média recente quando parado. */
  speedBps: number | null;
  log: ActivityEntry[];
  months: { month: string; count: number }[];
  totalSaved: number;
  totalBytes: number;
  /** Erro de ação para mostrar na UI (ex.: pasta sem permissão). */
  error: string | null;
  /** [2026-11-04] Pastas liberadas (§10.13). */
  fs: FsUiState;
  /** [2026-11-04] Enviar para o celular (§11): mais recentes primeiro. */
  outbox: OutboxUiItem[];
}
