// Pastas liberadas: tipo do volume de cada caminho (Lixeira disponível?) e nome da unidade (§10.2, §10.11).
// Tudo testável: o comando do sistema é injetado (`exec`) e o parse é puro.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FsPlatform } from '@arkivo/shared';

export interface VolumeInfo {
  /** Só exibição: `"C:"`, `"\\\\nas\\fotos"`, nome do volume em `/Volumes` ou `/media`; `null` se não souber. */
  drive: string | null;
  /** O volume tem Lixeira: `trash` e `replace` funcionam. Na dúvida, `false`. */
  trashAvailable: boolean;
}

export interface VolumeProbe {
  info(absPath: string): Promise<VolumeInfo>;
}

export type ExecFn = (file: string, args: string[]) => Promise<string>;

export const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(err.message, { cause: err }));
      else resolve(String(stdout));
    });
  });

// ------------------------------------------------------------------------------- Windows

/** `DriveType` do .NET (`[System.IO.DriveInfo]`): só `Fixed` tem Lixeira. */
export type WindowsDriveType = 'Fixed' | 'Removable' | 'Network' | 'CDRom' | 'Ram' | 'NoRootDirectory' | 'Unknown';

/** Linhas `C:\|Fixed` → mapa `c` → tipo. */
export function parseWindowsDriveTypes(out: string): Map<string, WindowsDriveType> {
  const m = new Map<string, WindowsDriveType>();
  for (const line of out.split(/\r?\n/)) {
    const r = /^\s*([A-Za-z]):\\?\s*\|\s*([A-Za-z]+)\s*$/.exec(line);
    if (r) m.set(r[1].toLowerCase(), r[2] as WindowsDriveType);
  }
  return m;
}

export const WINDOWS_DRIVE_TYPES_SCRIPT = "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name + '|' + $_.DriveType }";

// ------------------------------------------------------------------------------- unidades deste PC (§10.13)

/** Tipo legível de uma unidade na tela "Pastas liberadas" [2026-11-06]. */
export type DriveKind = 'fixed' | 'removable' | 'network' | 'cdrom' | 'other';

/** Uma unidade pronta para uso (as que não estão prontas, como leitor de cartão vazio, ficam de fora). */
export interface DriveEntry {
  /** Windows: a letra (`"C"`); macOS/Linux: o ponto de montagem. É o que o renderer manda de volta. */
  id: string;
  /** Raiz da unidade: `C:\`, `/Volumes/HD`. */
  root: string;
  /** `"C:"` ou o nome do volume em `/Volumes`, `/media`. */
  name: string;
  /** Nome do volume ("Windows", "SSD Dados"); `null` se não tiver. */
  volumeLabel: string | null;
  kind: DriveKind;
  totalBytes: number | null;
  freeBytes: number | null;
  /** Só unidade interna tem Lixeira (§10.11). */
  trashAvailable: boolean;
}

export interface DriveLister {
  listDrives(): Promise<DriveEntry[]>;
}

/**
 * Uma linha por unidade: `C:\|Fixed|True|<total>|<livre>|<nome do volume>` (o nome vem por último: pode ter `|`).
 * UTF-8 na saída, para nomes com acento. Unidade que não está pronta sai com `False` e campos vazios; uma que falha ao
 * ler (rede caída) também.
 */
export const WINDOWS_DRIVES_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  '[System.IO.DriveInfo]::GetDrives() | ForEach-Object {',
  "$r = $_.IsReady; $t = ''; $f = ''; $l = '';",
  'if ($r) { try { $t = $_.TotalSize; $f = $_.AvailableFreeSpace; $l = $_.VolumeLabel } catch { $r = $false } };',
  "$_.Name + '|' + $_.DriveType + '|' + $r + '|' + $t + '|' + $f + '|' + $l }",
].join(' ');

const WINDOWS_KINDS: Record<string, DriveKind> = { fixed: 'fixed', removable: 'removable', network: 'network', cdrom: 'cdrom' };
const KIND_TO_WINDOWS_TYPE: Record<DriveKind, WindowsDriveType> = {
  fixed: 'Fixed',
  removable: 'Removable',
  network: 'Network',
  cdrom: 'CDRom',
  other: 'Unknown',
};

function optNumber(s: string | undefined): number | null {
  if (!s || !/^\d{1,20}$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** Saída do `WINDOWS_DRIVES_SCRIPT` → unidades prontas, sem repetir letra, na ordem de `sortDrives`. */
export function parseWindowsDrives(out: string, systemDrive?: string): DriveEntry[] {
  const seen = new Set<string>();
  const list: DriveEntry[] = [];
  for (const raw of out.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const parts = raw.split('|');
    if (parts.length < 6) continue;
    const m = /^\s*([A-Za-z]):\\?\s*$/.exec(parts[0]);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    if (seen.has(letter) || parts[2].trim().toLowerCase() !== 'true') continue;
    seen.add(letter);
    const kind = WINDOWS_KINDS[parts[1].trim().toLowerCase()] ?? 'other';
    const label = parts.slice(5).join('|').trim();
    list.push({
      id: letter,
      root: `${letter}:\\`,
      name: `${letter}:`,
      volumeLabel: label || null,
      kind,
      totalBytes: optNumber(parts[3]),
      freeBytes: optNumber(parts[4]),
      trashAvailable: kind === 'fixed',
    });
  }
  return sortDrives(list, systemDrive);
}

/** A unidade do sistema primeiro; depois por letra (Windows) ou nome. */
export function sortDrives(list: DriveEntry[], systemDrive?: string): DriveEntry[] {
  const sys = (systemDrive ?? '').replace(/[:\\/]+$/, '').toUpperCase();
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  return [...list].sort((a, b) => {
    const as = sys && a.id.toUpperCase() === sys ? 0 : 1;
    const bs = sys && b.id.toUpperCase() === sys ? 0 : 1;
    return as - bs || collator.compare(a.name, b.name);
  });
}

/** Volumes montados no macOS/Linux que a tela mostra (o disco do sistema, `/`, não entra: não pode ser liberado). */
export function posixDriveCandidates(mounts: MountEntry[]): MountEntry[] {
  const seen = new Set<string>();
  return mounts.filter((m) => {
    const mp = m.mountPoint.replace(/\/+$/, '');
    if (!/^\/(Volumes|media|run\/media|mnt)\/.+/.test(mp) || seen.has(mp)) return false;
    if (/^(autofs|tmpfs|devtmpfs|proc|sysfs|squashfs|overlay)$/i.test(m.fsType)) return false;
    seen.add(mp);
    return true;
  });
}

/** Tipo legível ("Disco interno", "Pen drive / HD externo"...). */
export function driveKindLabel(kind: DriveKind): string {
  switch (kind) {
    case 'fixed':
      return 'Disco interno';
    case 'removable':
      return 'Pen drive / HD externo';
    case 'network':
      return 'Unidade de rede';
    case 'cdrom':
      return 'CD/DVD';
    default:
      return 'Outra unidade';
  }
}

// ------------------------------------------------------------------------------- macOS / Linux

export interface MountEntry {
  mountPoint: string;
  fsType: string;
  /** macOS: a opção `local` apareceu. Linux: `null` (decide pelo tipo). */
  local: boolean | null;
}

/** `/proc/self/mounts` (Linux): `dispositivo ponto tipo opções 0 0`, com `\040` etc. */
export function parseProcMounts(text: string): MountEntry[] {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    out.push({ mountPoint: unescape(parts[1]), fsType: parts[2], local: null });
  }
  return out;
}

/** Saída do `mount` do macOS: `//u@nas/x on /Volumes/x (smbfs, nodev, nosuid, mounted by u)`. */
export function parseMacMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const r = /^(.+?) on (.+) \(([^)]*)\)\s*$/.exec(line.trim());
    if (!r) continue;
    const opts = r[3].split(',').map((s) => s.trim());
    out.push({ mountPoint: r[2], fsType: opts[0] ?? '', local: opts.includes('local') });
  }
  return out;
}

const NETWORK_FS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  'ncpfs',
  'afs',
  '9p',
  'ceph',
  'glusterfs',
  'davfs',
  'webdav',
  'afpfs',
  'ftp',
  'sshfs',
]);
/** FUSE local conhecido (o resto do FUSE pode ser rede: na dúvida, sem Lixeira). */
const LOCAL_FUSE = new Set(['fuseblk', 'fuse.ntfs-3g', 'fuse.exfat', 'fuse.exfat-fuse']);

export function mountHasTrash(m: MountEntry): boolean {
  const t = m.fsType.toLowerCase();
  if (NETWORK_FS.has(t) || t.startsWith('fuse.sshfs') || t.startsWith('fuse.rclone')) return false;
  if (t.startsWith('fuse') && !LOCAL_FUSE.has(t)) return false;
  if (m.local === false) return false;
  return true;
}

/** Ponto de montagem mais longo que contém `abs`. */
export function findMount(mounts: MountEntry[], abs: string): MountEntry | null {
  let best: MountEntry | null = null;
  for (const m of mounts) {
    const mp = m.mountPoint.replace(/\/+$/, '') || '/';
    const inside = mp === '/' || abs === mp || abs.startsWith(mp + '/');
    if (inside && (!best || mp.length > best.mountPoint.replace(/\/+$/, '').length)) best = m;
  }
  return best;
}

/** Nome do volume para exibição em macOS/Linux (`/Volumes/HD`, `/media/u/HD`, `/run/media/u/HD`, `/mnt/HD`). */
export function posixDriveLabel(mountPoint: string | null): string | null {
  if (!mountPoint || mountPoint === '/') return null;
  if (/^\/(Volumes|media|run\/media|mnt)\//.test(mountPoint)) return path.posix.basename(mountPoint);
  return null;
}

// ------------------------------------------------------------------------------- sonda com cache

export interface SystemVolumeProbeOptions {
  platform: FsPlatform;
  exec?: ExecFn;
  readFile?: (file: string) => Promise<string>;
  /** Cache do tipo de cada unidade (padrão 60 s). */
  ttlMs?: number;
  now?: () => number;
  /** Windows: `%SystemDrive%`, para pôr a unidade do sistema primeiro na lista. */
  systemDrive?: string;
  /** Espaço de um volume montado no macOS/Linux (padrão: `fs.statfs`). */
  statfs?: (mountPoint: string) => Promise<{ totalBytes: number; freeBytes: number } | null>;
}

async function defaultStatfs(mountPoint: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const s = await fsp.statfs(mountPoint);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

export class SystemVolumeProbe implements VolumeProbe, DriveLister {
  private readonly exec: ExecFn;
  private readonly readFile: (file: string) => Promise<string>;
  private readonly ttl: number;
  private readonly now: () => number;
  private winCache: { at: number; types: Map<string, WindowsDriveType> } | null = null;
  private winPending: Promise<Map<string, WindowsDriveType>> | null = null;
  private mountCache: { at: number; mounts: MountEntry[] } | null = null;

  constructor(private readonly o: SystemVolumeProbeOptions) {
    this.exec = o.exec ?? defaultExec;
    this.readFile = o.readFile ?? ((f) => fsp.readFile(f, 'utf8'));
    this.ttl = o.ttlMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  async info(absPath: string): Promise<VolumeInfo> {
    if (this.o.platform === 'windows') return this.windowsInfo(absPath);
    return this.posixInfo(absPath);
  }

  /**
   * Unidades deste PC para a tela "Pastas liberadas" (§10.13 [2026-11-06]). Sem cache: a tela pede a cada ~10 s e ao
   * ganhar foco, para um pen drive conectado aparecer sozinho. No Windows também renova o cache de tipos (Lixeira).
   * Falha do comando → lista vazia (a tela continua com "Adicionar pasta").
   */
  async listDrives(): Promise<DriveEntry[]> {
    if (this.o.platform === 'windows') {
      let list: DriveEntry[];
      try {
        list = parseWindowsDrives(
          await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DRIVES_SCRIPT]),
          this.o.systemDrive,
        );
      } catch {
        return [];
      }
      if (list.length) {
        const types = new Map(this.winCache?.types ?? []);
        for (const d of list) types.set(d.id.toLowerCase(), KIND_TO_WINDOWS_TYPE[d.kind]);
        this.winCache = { at: this.now(), types };
      }
      return list;
    }
    this.mountCache = null;
    const statfs = this.o.statfs ?? defaultStatfs;
    const out: DriveEntry[] = [];
    for (const m of posixDriveCandidates(await this.mounts())) {
      const mp = m.mountPoint.replace(/\/+$/, '');
      const space = await statfs(mp);
      if (!space) continue; // desmontado entre a leitura e agora
      const hasTrash = mountHasTrash(m);
      out.push({
        id: mp,
        root: mp,
        name: path.posix.basename(mp),
        volumeLabel: null,
        kind: hasTrash ? 'removable' : 'network',
        totalBytes: space.totalBytes,
        freeBytes: space.freeBytes,
        trashAvailable: hasTrash,
      });
    }
    return sortDrives(out);
  }

  private async windowsInfo(absPath: string): Promise<VolumeInfo> {
    const p = absPath
      .replace(/\//g, '\\')
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/, '');
    const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(p);
    // Compartilhamento de rede (`\\nas\fotos`): sem Lixeira.
    if (unc) return { drive: `\\\\${unc[1]}\\${unc[2]}`, trashAvailable: false };
    const letter = /^([A-Za-z]):/.exec(p)?.[1]?.toLowerCase();
    if (!letter) return { drive: null, trashAvailable: false };
    const drive = `${letter.toUpperCase()}:`;
    let types = await this.windowsTypes(false);
    if (!types.has(letter)) types = await this.windowsTypes(true); // unidade nova (pen drive acabou de entrar)
    return { drive, trashAvailable: types.get(letter) === 'Fixed' };
  }

  private async windowsTypes(force: boolean): Promise<Map<string, WindowsDriveType>> {
    const t = this.now();
    if (!force && this.winCache && t - this.winCache.at < this.ttl) return this.winCache.types;
    if (!this.winPending) {
      this.winPending = this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DRIVE_TYPES_SCRIPT])
        .then((out) => parseWindowsDriveTypes(out))
        .catch(() => new Map<string, WindowsDriveType>())
        .then((types) => {
          this.winCache = { at: this.now(), types };
          return types;
        })
        .finally(() => {
          this.winPending = null;
        });
    }
    return this.winPending;
  }

  private async posixInfo(absPath: string): Promise<VolumeInfo> {
    const mounts = await this.mounts();
    const m = findMount(mounts, absPath);
    if (!m) return { drive: null, trashAvailable: false };
    return { drive: posixDriveLabel(m.mountPoint), trashAvailable: mountHasTrash(m) };
  }

  private async mounts(): Promise<MountEntry[]> {
    const t = this.now();
    if (this.mountCache && t - this.mountCache.at < this.ttl) return this.mountCache.mounts;
    let mounts: MountEntry[];
    try {
      mounts =
        this.o.platform === 'macos'
          ? parseMacMounts(await this.exec('/sbin/mount', []))
          : parseProcMounts(await this.readFile('/proc/self/mounts'));
    } catch {
      mounts = [];
    }
    this.mountCache = { at: t, mounts };
    return mounts;
  }
}
