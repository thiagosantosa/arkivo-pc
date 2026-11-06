import { app, BrowserWindow, clipboard, dialog, IpcMainInvokeEvent, ipcMain, Menu, nativeImage, NativeImage, shell, Tray } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fsDriveLetter, isFsDriveRoot, type PcPlatform } from '@arkivo/shared';
import { ActionResult, IPC, type FsAddActionResult, type OutboxActionResult } from '../common/ipc';
import { Agent } from '../core/agent';
import type { AgentState } from '../core/agent-state';
import { driveRootLabel } from '../core/fs-roots';
import { consoleLogger } from '../core/types';
import { qrEncoder, safeStorageCipher, wsFactory } from './adapters';
import { applyAutostart, launchedHidden } from './autostart';
import { electronFsPlatform } from './fs-electron';

const API_URL = resolveApiUrl();
const PLATFORM: PcPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).toString();
const ASSETS = path.join(app.getAppPath(), 'assets');

/**
 * Endereço da API, nesta ordem:
 * 1. `ARKIVO_API_URL` no ambiente;
 * 2. `build-config.json` gravado no build (`npm run dist:win:teste` grava http://localhost:3000);
 * 3. padrão: https://api.arkivo.com no instalador, http://localhost:3000 em dev.
 */
function resolveApiUrl(): string {
  if (process.env.ARKIVO_API_URL) return process.env.ARKIVO_API_URL;
  try {
    const cfg = JSON.parse(readFileSync(path.join(__dirname, 'build-config.json'), 'utf8')) as { apiUrl?: unknown };
    if (typeof cfg.apiUrl === 'string' && /^https?:\/\//.test(cfg.apiUrl)) return cfg.apiUrl.replace(/\/+$/, '');
  } catch {
    /* sem build-config.json */
  }
  return app.isPackaged ? 'https://api.arkivo.com' : 'http://localhost:3000';
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let agent: Agent | null = null;
let quitting = false;
let shutdownDone = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  if (process.platform === 'win32') app.setAppUserModelId('com.arkivo.pc');
  app.whenReady().then(start).catch((err) => {
    consoleLogger.error('Falha ao iniciar', err);
    dialog.showErrorBox('Arkivo para PC', `Não foi possível iniciar.\n\n${err instanceof Error ? err.message : String(err)}`);
    app.exit(1);
  });
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  agent = new Agent({
    dataDir: app.getPath('userData'),
    cipher: safeStorageCipher,
    wsFactory,
    qr: qrEncoder,
    appVersion: app.getVersion(),
    platform: PLATFORM,
    pcName: os.hostname(),
    apiBaseUrl: API_URL,
    suggestedStorageDir: path.join(app.getPath('pictures'), 'Arkivo'),
    logger: consoleLogger,
    // Pastas liberadas: Lixeira e miniaturas pelo Electron (o resto do recurso é Node puro, em src/core).
    fsPlatform: electronFsPlatform(),
  });
  agent.on('state', (s: AgentState) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.state, s);
    updateTray(s);
  });
  registerIpc(agent);
  await agent.init();
  await applyAutostart(agent.state.autostart).catch((err) => consoleLogger.warn('Autostart', err));

  createTray();
  createWindow();
  // Aberto pelo login do SO e já pareado: fica só na bandeja.
  const startHidden = launchedHidden() && agent.state.phase === 'active';
  if (!startHidden) win!.once('ready-to-show', () => showWindow());

  app.on('activate', () => showWindow()); // macOS: clique no Dock
}

// -------------------------------------------------------------------- janela

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 680,
    minHeight: 500,
    show: false,
    title: 'Arkivo para PC',
    backgroundColor: '#161826',
    icon: loadIcon('icon.png'),
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : { titleBarOverlay: { color: '#292b31', symbolColor: '#e9e9ed', height: 36 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.argv.includes('--dev'),
    },
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (url !== RENDERER_URL) e.preventDefault();
  });
  wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (process.argv.includes('--dev')) wc.openDevTools({ mode: 'detach' });

  win.on('close', (e) => {
    if (quitting) return;
    // Fechar só esconde: o Arkivo continua recebendo em segundo plano.
    e.preventDefault();
    win?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(RENDERER_INDEX);
}

function showWindow(): void {
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) createWindow();
  if (process.platform === 'darwin') void app.dock?.show();
  const w = win!;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// -------------------------------------------------------------------- bandeja

function loadIcon(name: string): NativeImage {
  const img = nativeImage.createFromPath(path.join(ASSETS, name));
  return img;
}

function createTray(): void {
  const icon = process.platform === 'darwin' ? loadIcon('trayTemplate.png') : loadIcon('tray.png');
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Arkivo para PC · Rodando em segundo plano');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  if (agent) updateTray(agent.state);
}

function trayStatus(s: AgentState): string {
  if (s.phase === 'updateRequired') return 'Atualize o Arkivo para PC';
  if (s.phase === 'folder' || s.phase === 'pairing') return 'Aguardando pareamento';
  const n = s.active.length + s.queued;
  if (n > 0) return `Recebendo ${n} ${n === 1 ? 'arquivo' : 'arquivos'}`;
  if (s.totalSaved > 0) return `${s.totalSaved} arquivos guardados`;
  return 'Pareado com o celular';
}

let lastTrayLabel = '';
function updateTray(s: AgentState): void {
  if (!tray) return;
  const label = trayStatus(s);
  if (label === lastTrayLabel) return;
  lastTrayLabel = label;
  tray.setToolTip(`Arkivo para PC · ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o Arkivo', click: () => showWindow() },
      { label, enabled: false },
      { type: 'separator' },
      {
        label: 'Abrir a pasta',
        enabled: !!s.storageDir,
        click: () => {
          if (agent?.state.storageDir) void shell.openPath(agent.state.storageDir);
        },
      },
      { type: 'separator' },
      { label: 'Rodando em segundo plano', enabled: false },
      {
        label: 'Sair do Arkivo',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// -------------------------------------------------------------------- IPC

function trusted(e: IpcMainInvokeEvent): boolean {
  return !!win && e.sender === win.webContents && (e.senderFrame?.url ?? '') === RENDERER_URL;
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => Promise<ActionResult | unknown>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) throw new Error('Origem IPC não confiável');
    try {
      return await fn(e, ...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      consoleLogger.warn(`IPC ${channel}`, message);
      return { ok: false, error: message } satisfies ActionResult;
    }
  });
}

function registerIpc(a: Agent): void {
  const ok: ActionResult = { ok: true };

  handle(IPC.getState, async () => a.state);

  handle(IPC.chooseFolder, async () => {
    if (!win) return { ok: false };
    const r = await dialog.showOpenDialog(win, {
      title: 'Onde guardar seus arquivos?',
      defaultPath: a.state.storageDir ?? app.getPath('pictures'),
      buttonLabel: 'Escolher esta pasta',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    await a.setStorageDir(r.filePaths[0]);
    return ok;
  });

  handle(IPC.setAutostart, async (_e, on) => {
    const enabled = on === true;
    await applyAutostart(enabled);
    await a.setAutostart(enabled);
    return ok;
  });

  handle(IPC.continuePairing, async () => {
    await a.continueToPairing();
    return ok;
  });

  handle(IPC.unpair, async () => {
    await a.unpairPhone();
    return ok;
  });

  handle(IPC.logout, async () => {
    await a.logout();
    return ok;
  });

  handle(IPC.openFolder, async () => {
    const dir = a.state.storageDir;
    if (!dir) return { ok: false };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : ok;
  });

  handle(IPC.clearError, async () => {
    a.clearError();
    return ok;
  });

  // ------------------------------------------------------------ pastas liberadas (§10.13)
  const rootId = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(v)) throw new Error('Pasta inválida');
    return v;
  };

  /**
   * Confere a pasta e libera na hora, ou, se for uma unidade inteira (ou trocar pastas já liberadas), guarda o pedido
   * e devolve `confirm` com um `token`: o renderer só confirma o `token`, nunca manda caminho (§10.13 [2026-11-06]).
   */
  let pendingAdd: { token: string; dir: string; label?: string; replace: string[]; at: number } | null = null;
  const addOrConfirm = async (dir: string, label?: string): Promise<FsAddActionResult> => {
    const plan = await a.fsPlanRoot(dir, { label });
    if (!plan.wholeDrive && !plan.replaces.length) {
      pendingAdd = null;
      await a.fsAddRoot(dir, { label });
      return ok;
    }
    const token = randomBytes(16).toString('base64url');
    pendingAdd = { token, dir, label, replace: plan.replaces.map((r) => r.id), at: Date.now() };
    return {
      ok: false,
      confirm: {
        token,
        label: plan.label,
        path: plan.requested,
        drive: plan.drive,
        systemDrive: plan.systemDrive,
        wholeDrive: plan.wholeDrive,
        replaces: plan.replaces.map((r) => ({ id: r.id, label: r.label, absPath: r.absPath })),
      },
    };
  };
  const pickFolder = async (defaultPath?: string): Promise<string | null> => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolha uma pasta para o celular acessar',
      buttonLabel: 'Liberar esta pasta',
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };

  /** Raiz de unidade escolhida no seletor: o rótulo vem da lista de unidades ("Windows (C:)", "Pen drive (E:)"). */
  const driveLabelFor = async (dir: string): Promise<string | undefined> => {
    if (!isFsDriveRoot(dir, a.state.platform)) return undefined;
    const d = await a.fsDrive(fsDriveLetter(dir, a.state.platform)?.slice(0, 1));
    return d ? driveRootLabel(d, a.state.platform) : undefined;
  };

  handle(IPC.fsAddRoot, async () => {
    // Sem `defaultPath` restrito: o seletor do sistema mostra todas as unidades (C:, D:, HD externo, rede mapeada).
    const dir = await pickFolder();
    if (!dir) return { ok: false, canceled: true } satisfies FsAddActionResult;
    return addOrConfirm(dir, await driveLabelFor(dir));
  });

  // O renderer manda só o `id` de uma unidade da lista; o caminho vem da enumeração feita aqui, agora.
  handle(IPC.fsAddDrive, async (_e, id) => {
    const d = await a.fsDrive(id);
    if (!d) return { ok: false, error: 'Esta unidade não está mais conectada ao PC.' } satisfies FsAddActionResult;
    if (a.state.platform !== 'windows') return { ok: false, error: 'Escolha uma pasta dentro desta unidade.' } satisfies FsAddActionResult;
    return addOrConfirm(d.root, driveRootLabel(d, a.state.platform));
  });

  handle(IPC.fsChooseInDrive, async (_e, id) => {
    const d = await a.fsDrive(id);
    if (!d) return { ok: false, error: 'Esta unidade não está mais conectada ao PC.' } satisfies FsAddActionResult;
    const dir = await pickFolder(d.root);
    if (!dir) return { ok: false, canceled: true } satisfies FsAddActionResult;
    // Escolheu a raiz de uma unidade no seletor: o mesmo aviso de "Liberar inteira" (`plan` decide).
    return addOrConfirm(dir, await driveLabelFor(dir));
  });

  handle(IPC.fsConfirmAdd, async (_e, token) => {
    const p = pendingAdd;
    // Um pedido por vez, válido por 5 min: o diálogo de confirmação é o último que a tela abriu.
    if (!p || typeof token !== 'string' || token !== p.token || Date.now() - p.at > 5 * 60_000) {
      pendingAdd = null;
      return { ok: false, error: 'Este pedido expirou. Tente de novo.' };
    }
    pendingAdd = null;
    // `add` confere tudo de novo; se surgir outra pasta para trocar desde o aviso, recusa (`RootReplaceRequiredError`).
    await a.fsAddRoot(p.dir, { label: p.label, replace: p.replace });
    return ok;
  });

  handle(IPC.fsRefreshDrives, async () => {
    await a.refreshDrives();
    return ok;
  });

  handle(IPC.fsRemoveRoot, async (_e, id) => {
    await a.fsRemoveRoot(rootId(id));
    return ok;
  });

  handle(IPC.fsRenameRoot, async (_e, id, label) => {
    if (typeof label !== 'string' || label.length > 256) return { ok: false, error: 'Nome inválido' };
    await a.fsRenameRoot(rootId(id), label);
    return ok;
  });

  handle(IPC.fsSetEnabled, async (_e, on) => {
    await a.fsSetEnabled(on === true);
    return ok;
  });

  handle(IPC.fsOpenRoot, async (_e, id) => {
    const root = a.fs.roots.get(rootId(id));
    if (!root) return { ok: false };
    const err = await shell.openPath(root.absPath);
    return err ? { ok: false, error: err } : ok;
  });

  handle(IPC.fsClearAudit, async () => {
    await a.fsClearAudit();
    return ok;
  });

  // ------------------------------------------------------------ enviar para o celular (§11)
  const phoneIdOf = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error('Celular inválido');
    return v;
  };
  const outboxAdd = async (paths: readonly unknown[], phoneId: string): Promise<OutboxActionResult> => {
    const r = await a.outboxAdd(paths, phoneId);
    return { ok: true, added: r.added.length, rejected: r.rejected };
  };

  handle(IPC.outboxPick, async (_e, phone) => {
    if (!win) return { ok: false } satisfies OutboxActionResult;
    const phoneId = phoneIdOf(phone);
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolha os arquivos para enviar ao celular',
      buttonLabel: 'Enviar para o celular',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true } satisfies OutboxActionResult;
    return outboxAdd(r.filePaths, phoneId);
  });

  // Caminhos vindos do preload: `FsOutbox.add` confere cada um de novo (arquivo comum, sem link, sem bloqueio, tamanho).
  handle(IPC.outboxAddPaths, async (_e, paths, phone) => {
    const phoneId = phoneIdOf(phone);
    if (!Array.isArray(paths) || paths.length > 500) return { ok: false, error: 'Escolha até 500 arquivos por vez.' } satisfies OutboxActionResult;
    return outboxAdd(paths as unknown[], phoneId);
  });

  handle(IPC.outboxCancel, async (_e, id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return { ok: false, error: 'Item inválido' };
    await a.outboxCancel(id);
    return ok;
  });

  // Só copia o link do pareamento que está na tela (nada arbitrário vindo do renderer).
  handle(IPC.copyText, async (_e, text) => {
    const link = a.state.pairing?.link;
    if (typeof text !== 'string' || !link || text !== link) return { ok: false };
    await clipboard.writeText(link);
    return ok;
  });
}

// -------------------------------------------------------------------- encerramento

app.on('window-all-closed', () => {
  // Não sai: continua na bandeja recebendo backups.
});

app.on('before-quit', (e) => {
  quitting = true;
  if (shutdownDone || !agent) return;
  e.preventDefault();
  const done = () => {
    shutdownDone = true;
    tray?.destroy();
    app.quit();
  };
  const timeout = setTimeout(done, 3_000);
  agent
    .shutdown()
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timeout);
      done();
    });
});
