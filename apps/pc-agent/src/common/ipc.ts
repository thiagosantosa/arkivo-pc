// Contrato IPC entre processo principal, preload e renderer.
// O preload (sandbox) não pode importar arquivos locais em tempo de execução,
// então ele repete os nomes dos canais — mantenha os dois em sincronia.
import type { AgentState } from '../core/agent-state';

export const IPC = {
  getState: 'arkivo:get-state',
  state: 'arkivo:state',
  chooseFolder: 'arkivo:choose-folder',
  setAutostart: 'arkivo:set-autostart',
  continuePairing: 'arkivo:continue-pairing',
  unpair: 'arkivo:unpair',
  logout: 'arkivo:logout',
  openFolder: 'arkivo:open-folder',
  clearError: 'arkivo:clear-error',
  copyText: 'arkivo:copy-text',
  // Pastas liberadas (§10.13)
  fsAddRoot: 'arkivo:fs-add-root',
  fsRemoveRoot: 'arkivo:fs-remove-root',
  fsRenameRoot: 'arkivo:fs-rename-root',
  fsSetEnabled: 'arkivo:fs-set-enabled',
  fsOpenRoot: 'arkivo:fs-open-root',
  fsClearAudit: 'arkivo:fs-clear-audit',
  // [2026-11-06] Unidades deste PC
  fsAddDrive: 'arkivo:fs-add-drive',
  fsChooseInDrive: 'arkivo:fs-choose-in-drive',
  fsConfirmAdd: 'arkivo:fs-confirm-add',
  fsRefreshDrives: 'arkivo:fs-refresh-drives',
  // Enviar para o celular (§11)
  outboxPick: 'arkivo:outbox-pick',
  outboxAddPaths: 'arkivo:outbox-add-paths',
  outboxCancel: 'arkivo:outbox-cancel',
} as const;

export type UiState = AgentState;

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Resultado de escolher ou soltar arquivos: `canceled` = fechou o seletor; `rejected` traz o motivo por arquivo. */
export interface OutboxActionResult extends ActionResult {
  canceled?: boolean;
  added?: number;
  rejected?: { name: string; reason: string }[];
}

/**
 * Liberar a unidade inteira pede confirmação (§10.13 [2026-11-06]): o processo principal guarda o caminho e devolve
 * só um `token`; o renderer confirma com o `token` (nunca manda um caminho).
 */
export interface FsAddConfirm {
  token: string;
  /** Rótulo que a raiz vai ganhar ("Disco local (C:)"). */
  label: string;
  /** Caminho mostrado no aviso (`C:\`). */
  path: string;
  /** `"C:"`. */
  drive: string | null;
  /** A unidade do Windows: o aviso lista o que continua bloqueado. */
  systemDrive: boolean;
  wholeDrive: boolean;
  /** Pastas já liberadas nesta unidade, que vão ser trocadas por ela. */
  replaces: { id: string; label: string; absPath: string }[];
}

/** Resultado de "Adicionar pasta", "Liberar inteira" e "Escolher pasta…": `confirm` = falta o usuário confirmar. */
export interface FsAddActionResult extends ActionResult {
  canceled?: boolean;
  confirm?: FsAddConfirm;
}

/** API exposta em `window.arkivo` pelo preload. */
export interface ArkivoBridge {
  /** `process.platform` do SO (win32, darwin, linux). */
  readonly platform: string;
  getState(): Promise<UiState>;
  /** Assina mudanças de estado; devolve a função para cancelar. */
  onState(cb: (s: UiState) => void): () => void;
  /** Abre o diálogo nativo de pasta e grava a escolha. */
  chooseFolder(): Promise<ActionResult>;
  setAutostart(on: boolean): Promise<ActionResult>;
  continuePairing(): Promise<ActionResult>;
  unpair(): Promise<ActionResult>;
  logout(): Promise<ActionResult>;
  openFolder(): Promise<ActionResult>;
  clearError(): Promise<ActionResult>;
  /** Copia o link de pareamento (`arkivo://pair?...`) para a área de transferência. */
  copyText(text: string): Promise<ActionResult>;
  /**
   * Abre o seletor de pasta do sistema e libera a escolhida (recusa vem em `error`, já com o texto da tela). Se a
   * escolhida for uma unidade inteira, volta `confirm` e nada é liberado até `fsConfirmAdd`.
   */
  fsAddRoot(): Promise<FsAddActionResult>;
  /** "Liberar inteira": `id` de `state.fs.drives`; o processo principal monta o caminho e pede confirmação. */
  fsAddDrive(id: string): Promise<FsAddActionResult>;
  /** "Escolher pasta…": o seletor do sistema abre já naquela unidade. */
  fsChooseInDrive(id: string): Promise<FsAddActionResult>;
  /** Confirma o `confirm.token` de uma das três acima. */
  fsConfirmAdd(token: string): Promise<ActionResult>;
  /** Enumera as unidades de novo (a tela chama ao abrir, ao ganhar foco e a cada ~10 s). */
  fsRefreshDrives(): Promise<ActionResult>;
  fsRemoveRoot(id: string): Promise<ActionResult>;
  fsRenameRoot(id: string, label: string): Promise<ActionResult>;
  /** Interruptor "Acesso pelo celular". */
  fsSetEnabled(on: boolean): Promise<ActionResult>;
  /** Abre a pasta liberada no Explorer/Finder. */
  fsOpenRoot(id: string): Promise<ActionResult>;
  /** "Limpar histórico" de "O que o celular fez". */
  fsClearAudit(): Promise<ActionResult>;
  /** Abre o seletor de arquivos do sistema e põe os escolhidos na fila do celular. */
  outboxPick(phoneId: string): Promise<OutboxActionResult>;
  /**
   * Arquivos soltos na janela. O preload resolve os caminhos com `webUtils.getPathForFile` (`File.path` não existe
   * mais) e o renderer nunca os vê; o processo principal confere cada um de novo.
   */
  outboxDrop(files: readonly Blob[], phoneId: string): Promise<OutboxActionResult>;
  /** "Cancelar" num item ativo ou "Remover da lista" num encerrado. */
  outboxCancel(id: string): Promise<ActionResult>;
}
