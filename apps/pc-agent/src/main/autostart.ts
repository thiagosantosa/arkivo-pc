import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HIDDEN_ARG = '--hidden';

/** Liga/desliga "Iniciar com o Windows e rodar em segundo plano". */
export async function applyAutostart(enabled: boolean): Promise<void> {
  if (process.platform === 'linux') {
    await linuxAutostart(enabled);
    return;
  }
  // Em dev (electron .) não registra para não abrir o Electron "cru" no login.
  if (!app.isPackaged) return;
  // `openAsHidden` (macOS) não existe mais no Electron atual: no macOS 13+ o item de login usa o
  // SMAppService. Lá o "abrir escondido" é decidido em `launchedHidden()` via `wasOpenedAtLogin`.
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath, // Windows
    args: [HIDDEN_ARG], // Windows
  });
}

/** O app foi aberto pelo login do SO (deve ficar só na bandeja)? */
export function launchedHidden(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true;
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  }
  return false;
}

async function linuxAutostart(enabled: boolean): Promise<void> {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
  const file = path.join(dir, 'arkivo-pc.desktop');
  if (!enabled) {
    await fsp.rm(file, { force: true });
    return;
  }
  if (!app.isPackaged) return;
  const exec = process.env.APPIMAGE || process.execPath;
  const desktop = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Arkivo para PC',
    `Exec="${exec.replace(/"/g, '\\"')}" ${HIDDEN_ARG}`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, desktop, 'utf8');
}
