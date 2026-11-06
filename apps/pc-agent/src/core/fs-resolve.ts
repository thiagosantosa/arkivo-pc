// Pastas liberadas: resolução de caminhos relativos do celular para caminhos absolutos no PC (contrato §10.2).
// Toda operação, nas duas vias, passa por aqui: `realpath` do alvo e da raiz, "dentro da raiz" e bloqueio do sistema.
import type { Stats } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fsBlockedReason, isAbsPathInside, type FsSystemContext } from '@arkivo/shared';
import { FsOpError, fsErrorFromErrno } from './fs-errors';
import type { RootRegistry, SharedRoot } from './fs-roots';
import { errnoCode } from './fs-utils';

export interface ResolvedRoot {
  root: SharedRoot;
  /** `realpath` da raiz agora. */
  real: string;
}

export interface ResolvedItem {
  root: SharedRoot;
  rootReal: string;
  /** Caminho relativo normalizado (o que o celular mandou). */
  rel: string;
  /**
   * Caminho absoluto para agir. Seguindo links: o `realpath` do alvo. Sem seguir (`item`): `realpath(pai)/nome`
   * (o próprio link).
   */
  abs: string;
  /** Nome no disco (pode ser NFD no Linux). */
  diskName: string;
  /** `stat` seguindo links (tipo e tamanho do conteúdo). */
  stat: Stats;
  /** `lstat` do próprio item. */
  isLink: boolean;
}

/** Recusa ao mover, renomear ou apagar uma pasta que contém o perfil, os dados do Arkivo ou o backup. */
export const PROTECTED_DIR_MESSAGE = 'Esta pasta guarda o seu perfil, os dados do Arkivo ou o backup. O celular não pode movê-la, renomeá-la nem apagá-la.';

export interface FsResolverOptions {
  roots: RootRegistry;
  /** Procurar nome equivalente em NFC/NFD no `readdir` do pai quando o `lstat` dá `ENOENT` (padrão: Linux). */
  normalizationFallback?: boolean;
}

/**
 * Resolve caminhos relativos à raiz. Recusas:
 * - raiz desconhecida → `ROOT_REMOVED`; inacessível → `ROOT_UNAVAILABLE`;
 * - `realpath` fora do `realpath` da raiz (link, junction, ponto de montagem) ou bloqueado → `FORBIDDEN_PATH`.
 */
export class FsResolver {
  private readonly nf: boolean;

  constructor(private readonly o: FsResolverOptions) {
    this.nf = o.normalizationFallback ?? o.roots.platform === 'linux';
  }

  get ctx(): FsSystemContext {
    return this.o.roots.ctx;
  }

  /** Windows e macOS não diferenciam maiúsculas (§10.2 item 5). */
  get caseInsensitive(): boolean {
    return this.ctx.platform !== 'linux';
  }

  inside(rootReal: string, p: string): boolean {
    return isAbsPathInside(rootReal, p, this.ctx.platform);
  }

  blocked(p: string): boolean {
    return fsBlockedReason(p, this.ctx) !== null;
  }

  /** Confere que `p` (já resolvido) pode ser usado: dentro da raiz e sem bloqueio. */
  allowed(rootReal: string, p: string): boolean {
    return this.inside(rootReal, p) && !this.blocked(p);
  }

  async root(rootId: string): Promise<ResolvedRoot> {
    const root = this.o.roots.get(rootId);
    if (!root) throw new FsOpError('ROOT_REMOVED');
    let real: string;
    try {
      real = await this.o.roots.realpath(root.absPath);
      if (!(await fsp.stat(real)).isDirectory()) throw new FsOpError('ROOT_UNAVAILABLE');
    } catch (err) {
      if (err instanceof FsOpError) throw err;
      const code = errnoCode(err);
      if (code === 'EACCES' || code === 'EPERM') throw new FsOpError('PERMISSION_DENIED');
      throw new FsOpError('ROOT_UNAVAILABLE');
    }
    // A raiz pode ter virado link para outro lugar depois de liberada: o destino também precisa ser permitido.
    if (this.blocked(real)) throw new FsOpError('FORBIDDEN_PATH');
    return { root, real };
  }

  /** Item existente, seguindo links (o `realpath` precisa ficar dentro da raiz). */
  async existing(rootId: string, rel: string): Promise<ResolvedItem> {
    const r = await this.root(rootId);
    const segs = rel ? rel.split('/') : [];
    const lexical = await this.locate(r.real, segs);
    let real: string;
    try {
      real = await this.o.roots.realpath(lexical);
    } catch (err) {
      throw resolveError(err);
    }
    if (!this.allowed(r.real, real) || this.blocked(lexical)) throw new FsOpError('FORBIDDEN_PATH');
    let st: Stats;
    let lst: Stats;
    try {
      st = await fsp.stat(real);
      lst = await fsp.lstat(lexical);
    } catch (err) {
      throw resolveError(err);
    }
    return { root: r.root, rootReal: r.real, rel, abs: real, diskName: path.basename(lexical), stat: st, isLink: lst.isSymbolicLink() };
  }

  /** Pasta existente (destino de `list`, `mkdir`, `move`, `upload`). */
  async directory(rootId: string, rel: string): Promise<ResolvedItem> {
    const d = await this.existing(rootId, rel);
    if (!d.stat.isDirectory()) throw new FsOpError('NOT_A_DIRECTORY');
    return d;
  }

  /**
   * O próprio item, sem seguir o último link (`rename`, `move`, `trash` agem no link, §10.2 item 3).
   * Link para fora da raiz (ou quebrado) continua recusado: ele nem aparece na listagem.
   */
  async item(rootId: string, rel: string): Promise<ResolvedItem> {
    if (!rel) throw new FsOpError('FORBIDDEN_PATH', 'A pasta liberada em si não pode ser movida, renomeada nem apagada.');
    const r = await this.root(rootId);
    const segs = rel.split('/');
    const parentLexical = await this.locate(r.real, segs.slice(0, -1));
    let parentReal: string;
    try {
      parentReal = await this.o.roots.realpath(parentLexical);
    } catch (err) {
      throw resolveError(err);
    }
    if (!this.allowed(r.real, parentReal)) throw new FsOpError('FORBIDDEN_PATH');
    const diskName = await this.findName(parentReal, segs[segs.length - 1]);
    const abs = path.join(parentReal, diskName);
    if (this.blocked(abs) || !this.inside(r.real, abs) || samePath(abs, r.real, this.caseInsensitive))
      throw new FsOpError('FORBIDDEN_PATH');
    // Mover ou apagar uma pasta leva junto o que há dentro: não pode ser a que contém o perfil do usuário, os dados
    // do Arkivo ou a pasta do backup (ex.: `Users` e `Users\ana` numa raiz `C:\`).
    for (const p of this.o.roots.protectedDirs()) {
      if (this.inside(abs, p)) throw new FsOpError('FORBIDDEN_PATH', PROTECTED_DIR_MESSAGE);
    }
    let lst: Stats;
    try {
      lst = await fsp.lstat(abs);
    } catch (err) {
      throw resolveError(err);
    }
    let st = lst;
    if (lst.isSymbolicLink()) {
      let target: string;
      try {
        target = await this.o.roots.realpath(abs);
        st = await fsp.stat(target);
      } catch {
        throw new FsOpError('FORBIDDEN_PATH');
      }
      if (!this.allowed(r.real, target)) throw new FsOpError('FORBIDDEN_PATH');
    }
    return { root: r.root, rootReal: r.real, rel, abs, diskName, stat: st, isLink: lst.isSymbolicLink() };
  }

  /**
   * Destino de um item novo `name` dentro da pasta `dirRel`. Não confere se já existe (quem chama decide a
   * política de conflito); recusa nome bloqueado (ex.: criar `.ssh`).
   */
  async newChild(rootId: string, dirRel: string, name: string): Promise<{ dir: ResolvedItem; abs: string }> {
    const dir = await this.directory(rootId, dirRel);
    const abs = path.join(dir.abs, await this.findName(dir.abs, name));
    if (!this.allowed(dir.rootReal, abs)) throw new FsOpError('FORBIDDEN_PATH');
    return { dir, abs };
  }

  /** Junta os segmentos e, no Linux, troca cada um pelo nome equivalente NFC/NFD que existir no disco. */
  async locate(base: string, segs: string[]): Promise<string> {
    const direct = path.join(base, ...segs);
    if (!this.nf || segs.length === 0) return direct;
    try {
      await fsp.lstat(direct);
      return direct;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') return direct;
    }
    let cur = base;
    for (const s of segs) cur = path.join(cur, await this.findName(cur, s));
    return cur;
  }

  /** Nome no disco equivalente a `name` (NFC) dentro de `dir`; o próprio `name` se nada equivalente existir. */
  private async findName(dir: string, name: string): Promise<string> {
    if (!this.nf) return name;
    try {
      await fsp.lstat(path.join(dir, name));
      return name;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') return name;
    }
    try {
      for (const n of await fsp.readdir(dir)) if (n.normalize('NFC') === name) return n;
    } catch {
      /* pai inexistente: o erro sai depois, no lstat/realpath */
    }
    return name;
  }
}

export function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return caseInsensitive ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function resolveError(err: unknown): FsOpError {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FsOpError('NOT_FOUND');
  if (code === 'ELOOP') return new FsOpError('FORBIDDEN_PATH');
  return fsErrorFromErrno(err, 'read');
}
