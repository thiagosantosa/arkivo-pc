// Pastas liberadas: as raízes escolhidas no PC (contrato §10.2). Ficam só no `config.json`; o celular vê
// `FsRootInfo` (sem o caminho absoluto).
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  FS_BLOCK_MESSAGES,
  FS_MAX_ROOTS,
  FS_PARTS_DIR_NAME,
  FS_ROOT_LABEL_MAX,
  fsDriveLetter,
  fsRootRejectReason,
  isAbsPathInside,
  isFsDriveRoot,
  randomFsId,
  type FsPlatform,
  type FsRootInfo,
  type FsSystemContext,
} from '@arkivo/shared';
import { freeBytes } from './net-info';
import type { DriveEntry, VolumeProbe } from './fs-volume';
import { Logger, silentLogger } from './types';

/** Como a raiz fica no `config.json`. */
export interface SharedRoot {
  id: string;
  label: string;
  /** Caminho absoluto já resolvido (`realpath`) no momento em que foi adicionada. */
  absPath: string;
  addedAt: string;
}

/** O que a tela do PC mostra (inclui o caminho absoluto, que nunca vai ao celular). */
export interface SharedRootView extends FsRootInfo {
  absPath: string;
}

export interface FsRootsPersist {
  load(): { roots: SharedRoot[]; enabled: boolean };
  save(p: { roots: SharedRoot[]; enabled: boolean }): Promise<void>;
}

/** Recusa ao adicionar/renomear uma raiz: a mensagem já é o texto da interface (§10.13). */
export class RootRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootRejectError';
  }
}

/** Liberar a unidade inteira trocaria pastas que o usuário ainda não confirmou (a tela pergunta de novo). */
export class RootReplaceRequiredError extends RootRejectError {
  constructor(readonly plan: RootAddPlan) {
    const names = plan.replaces.map((r) => `"${r.label}"`).join(', ');
    super(`Confirme a troca de ${names} pela unidade ${plan.drive ? `${plan.drive} ` : ''}inteira.`);
    this.name = 'RootReplaceRequiredError';
  }
}

// eslint-disable-next-line no-control-regex
const LABEL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * `FsSystemContext` do PC (§10.2): `os.homedir()`, as variáveis do Windows e, em `extraBlocked`, a pasta de dados
 * do Arkivo (`app.getPath('userData')`).
 */
export function buildFsSystemContext(o: {
  platform: FsPlatform;
  home: string;
  env: NodeJS.ProcessEnv;
  extraBlocked?: string[];
}): FsSystemContext {
  const ctx: FsSystemContext = { platform: o.platform, home: o.home, extraBlocked: (o.extraBlocked ?? []).filter(Boolean) };
  if (o.platform === 'windows') {
    const env = (k: string) => o.env[k] ?? o.env[k.toUpperCase()] ?? undefined;
    const sysDrive = env('SystemDrive') ?? 'C:';
    ctx.systemDrive = sysDrive;
    ctx.windowsDir = env('SystemRoot') ?? env('windir') ?? `${sysDrive}\\Windows`;
    const pf = [env('ProgramFiles'), env('ProgramFiles(x86)'), env('ProgramW6432')].filter((v): v is string => !!v);
    ctx.programFiles = pf.length ? [...new Set(pf)] : [`${sysDrive}\\Program Files`, `${sysDrive}\\Program Files (x86)`];
    ctx.programData = env('ProgramData') ?? `${sysDrive}\\ProgramData`;
  }
  return ctx;
}

function clipLabel(label: string, fallback: string): string {
  const l = label.normalize('NFC').replace(LABEL_CONTROL_CHARS, '').trim() || fallback;
  return [...l].slice(0, FS_ROOT_LABEL_MAX).join('');
}

/**
 * Rótulo padrão: nome da pasta; raiz de unidade sem mais informação → `Disco local (E:)`; compartilhamento
 * `\\nas\fotos` → `fotos`. Com a unidade da lista "Unidades deste PC", vale `driveRootLabel`.
 */
export function defaultRootLabel(abs: string, platform: FsPlatform): string {
  let label: string;
  if (platform === 'windows') {
    const p = abs.replace(/\//g, '\\').replace(/\\+$/, '');
    const drive = /^([A-Za-z]):$/.exec(p);
    const unc = /^\\\\[^\\]+\\([^\\]+)$/.exec(p);
    if (drive) label = `Disco local (${drive[1].toUpperCase()}:)`;
    else if (unc) label = unc[1];
    else label = path.win32.basename(p);
  } else {
    const p = abs.replace(/\/+$/, '');
    label = p ? path.posix.basename(p) : 'Disco';
  }
  return clipLabel(label, 'Pasta');
}

/**
 * Rótulo padrão de uma unidade inteira (§10.2 [2026-11-06]): o nome do volume com a letra, como no Explorer
 * ("Windows (C:)"), ou pelo tipo: "Disco local (C:)", "Pen drive (E:)", "Unidade de rede (Z:)", "CD/DVD (D:)".
 * No macOS/Linux, o nome do volume.
 */
export function driveRootLabel(d: Pick<DriveEntry, 'name' | 'volumeLabel' | 'kind'>, platform: FsPlatform): string {
  if (platform !== 'windows') return clipLabel(d.volumeLabel ?? d.name, 'Disco');
  const kind = { fixed: 'Disco local', removable: 'Pen drive', network: 'Unidade de rede', cdrom: 'CD/DVD', other: 'Unidade' }[d.kind];
  const suffix = ` (${d.name})`;
  const base = d.volumeLabel?.normalize('NFC').replace(LABEL_CONTROL_CHARS, '').trim() || kind;
  return clipLabel([...base].slice(0, FS_ROOT_LABEL_MAX - suffix.length).join('') + suffix, `${kind}${suffix}`);
}

/** O que liberar uma pasta faria, antes de liberar (a tela pede confirmação de unidade inteira e de troca). */
export interface RootAddPlan {
  /** Caminho pedido, normalizado (`C:\`). */
  requested: string;
  /** `realpath`: é o que fica guardado. */
  absPath: string;
  label: string;
  /** A unidade inteira do Windows (`C:\`, `E:\`): a tela mostra o aviso e pede confirmação. */
  wholeDrive: boolean;
  /** A unidade do sistema (`%SystemDrive%`). */
  systemDrive: boolean;
  /** `"C:"` quando é uma unidade do Windows. */
  drive: string | null;
  /** Pastas já liberadas dentro desta unidade: liberar a unidade inteira troca todas por ela (§10.2). */
  replaces: SharedRoot[];
}

export interface RootAddOptions {
  /** Rótulo no lugar do padrão (ex.: "Pen drive (E:)", vindo da lista de unidades). */
  label?: string;
  /** `id` das raízes que o usuário confirmou trocar pela unidade inteira. Precisa cobrir todas as de `replaces`. */
  replace?: readonly string[];
}

export function cleanRootLabel(input: unknown): string {
  const label = (typeof input === 'string' ? input : '')
    .normalize('NFC')
    .replace(LABEL_CONTROL_CHARS, '')
    .trim();
  if (!label) throw new RootRejectError('Digite um nome.');
  if ([...label].length > FS_ROOT_LABEL_MAX) throw new RootRejectError(`Use até ${FS_ROOT_LABEL_MAX} caracteres.`);
  return label;
}

export interface RootRegistryOptions {
  store: FsRootsPersist;
  ctx: FsSystemContext;
  volumes: VolumeProbe;
  /** Teto para conferir se a pasta está acessível (rede caída pode demorar). */
  availabilityTimeoutMs?: number;
  /**
   * Pastas que o celular nunca move, renomeia nem apaga, nem leva junto ao mover a pasta de cima (além do perfil do
   * usuário e de `extraBlocked`): a pasta do backup (§4 Organização). Lida a cada operação, porque pode mudar.
   */
  protectedDirs?: () => readonly (string | null | undefined)[];
  /**
   * `realpath` usado em toda a resolução (padrão: `fs.promises.realpath`, o nativo). Os testes trocam pelo de
   * JavaScript para simular uma raiz de unidade com `subst` (o nativo resolve o `subst` para a pasta de verdade).
   */
  realpath?: (p: string) => Promise<string>;
  now?: () => number;
  logger?: Logger;
}

/**
 * Raízes liberadas e o interruptor "Acesso pelo celular". Eventos: `changed` (adicionou, removeu, renomeou ou
 * mudou o interruptor) → o agente manda `fs.event rootsChanged` (§10.11).
 */
export class RootRegistry extends EventEmitter {
  private list: SharedRoot[];
  private switchOn: boolean;
  private readonly log: Logger;

  constructor(private readonly o: RootRegistryOptions) {
    super();
    const s = o.store.load();
    this.list = Array.isArray(s.roots) ? s.roots.filter((r) => r && typeof r.id === 'string' && typeof r.absPath === 'string') : [];
    this.switchOn = !!s.enabled;
    this.log = o.logger ?? silentLogger;
  }

  get ctx(): FsSystemContext {
    return this.o.ctx;
  }

  get platform(): FsPlatform {
    return this.o.ctx.platform;
  }

  get enabled(): boolean {
    return this.switchOn;
  }

  get roots(): readonly SharedRoot[] {
    return this.list;
  }

  get(id: string): SharedRoot | undefined {
    return this.list.find((r) => r.id === id);
  }

  /** `realpath` da resolução (nativo, salvo nos testes). */
  realpath(p: string): Promise<string> {
    return (this.o.realpath ?? fsp.realpath)(p);
  }

  /** Pastas que não podem ser movidas, renomeadas nem apagadas, nem levadas junto (perfil, dados do Arkivo, backup). */
  protectedDirs(): string[] {
    const extra = this.o.protectedDirs?.() ?? [];
    return [this.o.ctx.home, ...(this.o.ctx.extraBlocked ?? []), ...extra].filter((p): p is string => typeof p === 'string' && !!p);
  }

  async setEnabled(on: boolean): Promise<void> {
    if (this.switchOn === on) return;
    this.switchOn = on;
    await this.persist();
  }

  /**
   * Confere uma pasta sem liberar (§10.2, §10.13). Recusa com `RootRejectError` (texto pronto para a tela).
   * Raízes não se sobrepõem: pasta dentro de uma liberada, ou que contém uma liberada, é recusada; a exceção é a
   * **unidade inteira** do Windows, que vem com `replaces` (a tela oferece trocar essas pastas por ela).
   */
  async plan(dir: string, o: { label?: string } = {}): Promise<RootAddPlan> {
    const platform = this.platform;
    const abs = path.resolve(dir);
    let real: string;
    try {
      real = await this.realpath(abs);
      if (!(await fsp.stat(real)).isDirectory()) throw new Error('não é pasta');
    } catch {
      throw new RootRejectError('Não foi possível abrir esta pasta.');
    }
    for (const p of [abs, real]) {
      const reason = fsRootRejectReason(p, this.o.ctx);
      if (reason) throw new RootRejectError(FS_BLOCK_MESSAGES[reason]);
    }
    const wholeDrive = isFsDriveRoot(abs, platform);
    const drive = fsDriveLetter(abs, platform);
    const sys = (this.o.ctx.systemDrive ?? 'C:').replace(/[\\/]+$/, '').toUpperCase();
    const replaces: SharedRoot[] = [];
    for (const r of this.list) {
      const same = isAbsPathInside(r.absPath, real, platform) && isAbsPathInside(real, r.absPath, platform);
      const rWhole = isFsDriveRoot(r.absPath, platform);
      if (same) throw new RootRejectError(wholeDrive || rWhole ? 'Esta unidade já está liberada inteira.' : 'Esta pasta já está liberada.');
      if (isAbsPathInside(r.absPath, real, platform)) {
        if (rWhole)
          throw new RootRejectError(`Esta pasta já está liberada: ela fica em "${r.label}", a unidade ${fsDriveLetter(r.absPath, platform) ?? ''} inteira.`);
        throw new RootRejectError(`Esta pasta está dentro de "${r.label}", que já está liberada.`);
      }
      if (isAbsPathInside(real, r.absPath, platform)) {
        if (wholeDrive) replaces.push(r);
        else throw new RootRejectError(`Esta pasta contém "${r.label}", que já está liberada. Remova "${r.label}" antes.`);
      }
    }
    if (this.list.length - replaces.length >= FS_MAX_ROOTS) throw new RootRejectError(`Limite de ${FS_MAX_ROOTS} pastas.`);
    return {
      requested: abs,
      absPath: real,
      label: o.label ? clipLabel(o.label, defaultRootLabel(abs, platform)) : defaultRootLabel(wholeDrive ? abs : real, platform),
      wholeDrive,
      systemDrive: wholeDrive && drive === sys,
      drive,
      replaces,
    };
  }

  /**
   * Valida e adiciona uma pasta. Unidade inteira que contém pastas liberadas só entra com `replace` cobrindo todas
   * elas (senão `RootReplaceRequiredError`): as pastas saem e a unidade entra numa gravação só, e os envios parciais
   * delas são apagados, como no "Remover". No celular, as pastas trocadas respondem `ROOT_REMOVED`.
   */
  async add(dir: string, o: RootAddOptions = {}): Promise<SharedRoot> {
    const plan = await this.plan(dir, { label: o.label });
    const confirmed = new Set(o.replace ?? []);
    if (plan.replaces.some((r) => !confirmed.has(r.id))) throw new RootReplaceRequiredError(plan);
    const root: SharedRoot = {
      id: randomFsId(),
      label: plan.label,
      absPath: plan.absPath,
      addedAt: new Date((this.o.now ?? Date.now)()).toISOString(),
    };
    const gone = new Set(plan.replaces.map((r) => r.id));
    const first = this.list.length === 0;
    this.list = [...this.list.filter((r) => !gone.has(r.id)), root];
    // O interruptor fica desligado até a primeira pasta (§10.1): adicionar a primeira já libera o acesso.
    if (first) this.switchOn = true;
    await this.persist();
    for (const r of plan.replaces) await this.dropParts(r);
    return root;
  }

  async remove(id: string): Promise<SharedRoot | null> {
    const root = this.get(id);
    if (!root) return null;
    this.list = this.list.filter((r) => r.id !== id);
    await this.persist();
    await this.dropParts(root);
    return root;
  }

  /** Envios do celular pela metade numa raiz que saiu não servem mais (§10.5: "raiz removida → .part apagado"). */
  private async dropParts(root: SharedRoot): Promise<void> {
    await fsp.rm(path.join(root.absPath, FS_PARTS_DIR_NAME), { recursive: true, force: true }).catch((err: unknown) => {
      this.log.warn(`Não foi possível limpar os envios parciais de "${root.label}"`, err instanceof Error ? err.message : err);
    });
  }

  async rename(id: string, label: string): Promise<SharedRoot> {
    const root = this.get(id);
    if (!root) throw new RootRejectError('Esta pasta não está mais liberada.');
    const clean = cleanRootLabel(label);
    if (clean === root.label) return root;
    const next = { ...root, label: clean };
    this.list = this.list.map((r) => (r.id === id ? next : r));
    await this.persist();
    return next;
  }

  /** Estado atual de uma raiz (acessível, espaço livre, Lixeira). Raiz inacessível continua na lista (§10.11). */
  async info(root: SharedRoot): Promise<SharedRootView> {
    const available = await this.isAvailable(root.absPath);
    const vol = await this.o.volumes.info(root.absPath).catch(() => ({ drive: null, trashAvailable: false }));
    let free: number | null = null;
    if (available) free = await freeBytes(root.absPath).catch(() => null);
    return {
      id: root.id,
      label: root.label,
      drive: vol.drive,
      available,
      freeBytes: free,
      trashAvailable: available && vol.trashAvailable,
      addedAt: root.addedAt,
      absPath: root.absPath,
    };
  }

  infos(): Promise<SharedRootView[]> {
    return Promise.all(this.list.map((r) => this.info(r)));
  }

  private async isAvailable(abs: string): Promise<boolean> {
    const timeout = this.o.availabilityTimeoutMs ?? 3_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fsp.stat(abs).then(
          (st) => st.isDirectory(),
          () => false,
        ),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(): Promise<void> {
    await this.o.store.save({ roots: this.list, enabled: this.switchOn });
    this.emit('changed');
  }
}
