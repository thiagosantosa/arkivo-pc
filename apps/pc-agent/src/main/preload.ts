// Preload com sandbox: só pode usar `electron` (contextBridge/ipcRenderer).
// Nada de Node aqui. Os nomes dos canais espelham `src/common/ipc.ts`.
import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';
import type { ActionResult, ArkivoBridge, FsAddActionResult, OutboxActionResult, UiState } from '../common/ipc';

const CH = {
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
  fsAddRoot: 'arkivo:fs-add-root',
  fsRemoveRoot: 'arkivo:fs-remove-root',
  fsRenameRoot: 'arkivo:fs-rename-root',
  fsSetEnabled: 'arkivo:fs-set-enabled',
  fsOpenRoot: 'arkivo:fs-open-root',
  fsClearAudit: 'arkivo:fs-clear-audit',
  fsAddDrive: 'arkivo:fs-add-drive',
  fsChooseInDrive: 'arkivo:fs-choose-in-drive',
  fsConfirmAdd: 'arkivo:fs-confirm-add',
  fsRefreshDrives: 'arkivo:fs-refresh-drives',
  outboxPick: 'arkivo:outbox-pick',
  outboxAddPaths: 'arkivo:outbox-add-paths',
  outboxCancel: 'arkivo:outbox-cancel',
} as const;

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<ActionResult>;

const bridge: ArkivoBridge = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke(CH.getState) as Promise<UiState>,
  onState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: UiState) => cb(s);
    ipcRenderer.on(CH.state, listener);
    return () => {
      ipcRenderer.removeListener(CH.state, listener);
    };
  },
  chooseFolder: () => invoke(CH.chooseFolder),
  setAutostart: (on) => invoke(CH.setAutostart, !!on),
  continuePairing: () => invoke(CH.continuePairing),
  unpair: () => invoke(CH.unpair),
  logout: () => invoke(CH.logout),
  openFolder: () => invoke(CH.openFolder),
  clearError: () => invoke(CH.clearError),
  copyText: (text) => invoke(CH.copyText, String(text)),
  fsAddRoot: () => ipcRenderer.invoke(CH.fsAddRoot) as Promise<FsAddActionResult>,
  fsAddDrive: (id) => ipcRenderer.invoke(CH.fsAddDrive, String(id)) as Promise<FsAddActionResult>,
  fsChooseInDrive: (id) => ipcRenderer.invoke(CH.fsChooseInDrive, String(id)) as Promise<FsAddActionResult>,
  fsConfirmAdd: (token) => invoke(CH.fsConfirmAdd, String(token)),
  fsRefreshDrives: () => invoke(CH.fsRefreshDrives),
  fsRemoveRoot: (id) => invoke(CH.fsRemoveRoot, String(id)),
  fsRenameRoot: (id, label) => invoke(CH.fsRenameRoot, String(id), String(label)),
  fsSetEnabled: (on) => invoke(CH.fsSetEnabled, !!on),
  fsOpenRoot: (id) => invoke(CH.fsOpenRoot, String(id)),
  fsClearAudit: () => invoke(CH.fsClearAudit),
  outboxPick: (phoneId) => ipcRenderer.invoke(CH.outboxPick, String(phoneId)) as Promise<OutboxActionResult>,
  outboxDrop: (files, phoneId) => {
    // Os caminhos ficam aqui e no processo principal: o renderer só entrega os `File` do evento de soltar.
    const paths = Array.from(files, (f) => webUtils.getPathForFile(f as File));
    return ipcRenderer.invoke(CH.outboxAddPaths, paths, String(phoneId)) as Promise<OutboxActionResult>;
  },
  outboxCancel: (id) => invoke(CH.outboxCancel, String(id)),
};

contextBridge.exposeInMainWorld('arkivo', bridge);
