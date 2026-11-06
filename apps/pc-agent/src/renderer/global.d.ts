// Tipos globais do renderer (script clássico, sem módulos em tempo de execução).
type ArkivoBridge = import('../common/ipc').ArkivoBridge;
type UiState = import('../common/ipc').UiState;
type ActivityEntry = import('../core/agent-state').ActivityEntry;
type ActiveTransferView = import('../core/agent-state').ActiveTransferView;
type FsRootUiView = import('../core/agent-state').FsRootUiView;
type FsAuditUiEntry = import('../core/agent-state').FsAuditUiEntry;
type FsDriveUiView = import('../core/agent-state').FsDriveUiView;
type FsAddConfirm = import('../common/ipc').FsAddConfirm;
type FsAddActionResult = import('../common/ipc').FsAddActionResult;
type OutboxUiItem = import('../core/agent-state').OutboxUiItem;
type OutboxActionResult = import('../common/ipc').OutboxActionResult;

interface Window {
  arkivo: ArkivoBridge;
}
