import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { organizedRelativePath } from '@arkivo/shared';
import {
  DiskError,
  DurableWriteOptions,
  errnoCode,
  fsyncDir,
  fsyncFile,
  mkdirDurable,
  renameWithRetry,
  SerialQueue,
  SyncDir,
  writeStreamDurable,
} from './fs-utils';
import { freeBytes } from './net-info';
import { Logger, silentLogger } from './types';

/** Pasta (dentro da pasta escolhida) onde ficam os `.part` em andamento. */
export const PARTS_DIR_NAME = '.arkivo-parciais';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const MAX_NAME_BYTES = 200;

/**
 * Deixa um nome de arquivo seguro para qualquer SO:
 * - descarta diretórios (`../`, `C:\`, `/etc/`), mantendo só o último segmento;
 * - troca caracteres proibidos no Windows (`<>:"/\|?*` e controles) por `_`;
 * - remove pontos/espaços no fim, evita nomes reservados (CON, NUL, COM1...);
 * - limita o tamanho preservando a extensão.
 */
export function sanitizeFileName(input: string): string {
  let name = String(input ?? '').normalize('NFC');
  const segments = name.split(/[\\/]+/).filter((s) => s.length > 0);
  name = segments.length ? segments[segments.length - 1] : '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_');
  name = name.replace(/[. ]+$/g, '').replace(/^\s+/, '');
  if (!name || /^\.+$/.test(name)) name = 'arquivo';
  const ext = path.extname(name);
  let base = ext ? name.slice(0, -ext.length) : name;
  if (WINDOWS_RESERVED.test(base) || WINDOWS_RESERVED.test(name.split('.')[0])) base = `_${base}`;
  if (!base) base = 'arquivo';
  // Limite por bytes (UTF-8), cortando a base e mantendo a extensão (até 20 bytes).
  const safeExt = Buffer.byteLength(ext) <= 20 ? ext : '';
  while (Buffer.byteLength(base + safeExt) > MAX_NAME_BYTES) base = [...base].slice(0, -1).join('');
  return base + safeExt;
}

/** Diretório relativo `AAAA/MM` no fuso local do PC. Data inválida → data atual. */
export function monthFolder(takenAt: string | undefined | null, now: Date = new Date()): string {
  let d = takenAt ? new Date(takenAt) : now;
  if (Number.isNaN(d.getTime())) d = now;
  const rel = organizedRelativePath(d.toISOString(), 'x', d.getTimezoneOffset());
  return rel.slice(0, rel.lastIndexOf('/'));
}

/** Nome com sufixo de colisão: `foto.jpg` → `foto (2).jpg`. */
export function withCollisionSuffix(name: string, n: number): string {
  if (n <= 1) return name;
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${base} (${n})${ext && ext !== name ? ext : ''}`;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Chave segura para nomear um `.part` (IDs vêm de fora). */
export function safeKey(key: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(key)) throw new Error('Identificador inválido');
  return key;
}

export interface PlaceInput {
  partPath: string;
  name: string;
  takenAt: string | null | undefined;
  /** SHA-256 já conferido do `.part`. */
  hash: string;
}

export interface PlaceResult {
  /** Caminho relativo com `/` (é o que vai para a API). */
  relativePath: string;
  absolutePath: string;
  /** `true` quando já existia um arquivo idêntico (mesmo nome e hash): nada foi gravado. */
  alreadyExisted: boolean;
}

export interface StorageOptions {
  logger?: Logger;
  /** fsync de diretório (padrão: `fsyncDir`, que nunca lança). Injetável para testes. */
  syncDir?: SyncDir;
}

/**
 * Pasta de destino e `.part`. Garantia de durabilidade (o celular apaga o original quando o PC
 * diz "conferido"):
 * - `writePart` só termina depois de `fh.sync()` + `close` (cada pedaço aceito está no disco);
 * - `hashFile` relê o arquivo já sincronizado e fechado;
 * - `placeVerified` faz o `rename` atômico e depois o fsync do diretório de destino e do de origem
 *   (e dos pais de pastas `AAAA/MM` recém-criadas).
 * Só depois disso quem chamou pode responder `verifiedHash`, reportar o local ou dar ack.
 */
export class Storage {
  private readonly placing = new SerialQueue();
  private readonly log: Logger;
  private readonly syncDirImpl: SyncDir;

  constructor(
    private readonly getRoot: () => string | null,
    opts: StorageOptions = {},
  ) {
    this.log = opts.logger ?? silentLogger;
    this.syncDirImpl = opts.syncDir ?? ((dir) => fsyncDir(dir, { logger: this.log }));
  }

  get root(): string | null {
    return this.getRoot();
  }

  requireRoot(): string {
    const r = this.getRoot();
    if (!r) throw new Error('Pasta de destino não configurada');
    return r;
  }

  partsDir(): string {
    return path.join(this.requireRoot(), PARTS_DIR_NAME);
  }

  partPath(key: string): string {
    return path.join(this.partsDir(), `${safeKey(key)}.part`);
  }

  async ensurePartsDir(): Promise<string> {
    const dir = this.partsDir();
    await mkdirDurable(dir, this.syncDirImpl);
    return dir;
  }

  /**
   * Grava no `.part` e só resolve depois de `fh.sync()` + `close` (ver `writeStreamDurable`).
   * Erros do disco saem como `DiskError`.
   */
  writePart(key: string, streams: NodeJS.ReadableStream[], opts: DurableWriteOptions): Promise<void> {
    return writeStreamDurable(this.partPath(key), streams, opts);
  }

  /** fsync de um `.part` que não foi escrito agora (ex.: completo desde uma execução anterior). */
  syncPart(key: string): Promise<void> {
    return fsyncFile(this.partPath(key));
  }

  /** SHA-256 do arquivo (chamar só depois do fsync + close). */
  hashFile(file: string): Promise<string> {
    return sha256File(file);
  }

  /** Tamanho atual do `.part` (0 se não existe). */
  async partSize(key: string): Promise<number> {
    try {
      return (await fsp.stat(this.partPath(key))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  async removePart(key: string): Promise<void> {
    await fsp.rm(this.partPath(key), { force: true });
  }

  async freeBytes(): Promise<number> {
    return freeBytes(this.requireRoot());
  }

  /**
   * Move um `.part` já verificado para `<raiz>/AAAA/MM/<nome>`.
   * Mesmo nome + mesmo hash = já salvo (idempotente, apaga o `.part`).
   * Mesmo nome + hash diferente = tenta ` (2)`, ` (3)`...
   */
  placeVerified(input: PlaceInput): Promise<PlaceResult> {
    return this.placing.run(async () => {
      const root = this.requireRoot();
      const relDir = monthFolder(input.takenAt);
      const absDir = path.join(root, ...relDir.split('/'));
      ensureInside(root, absDir);
      await mkdirDurable(absDir, this.syncDirImpl);
      const clean = sanitizeFileName(input.name);
      for (let n = 1; n < 10_000; n++) {
        const candidate = withCollisionSuffix(clean, n);
        const abs = path.join(absDir, candidate);
        ensureInside(root, abs);
        const rel = `${relDir}/${candidate}`;
        let exists = true;
        try {
          await fsp.lstat(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          exists = false;
        }
        if (!exists) {
          await renameWithRetry(input.partPath, abs);
          // A entrada nova no destino e a saída da pasta de parciais precisam chegar ao disco.
          await this.syncDirImpl(absDir);
          const srcDir = path.dirname(path.resolve(input.partPath));
          if (srcDir !== path.resolve(absDir)) await this.syncDirImpl(srcDir);
          return { relativePath: rel, absolutePath: abs, alreadyExisted: false };
        }
        const st = await fsp.lstat(abs);
        if (st.isFile() && (await this.hashFile(abs)) === input.hash) {
          // Já existia (gravado antes por nós ou copiado pelo usuário): garante que está no disco.
          await this.syncExisting(abs);
          await this.syncDirImpl(absDir);
          await fsp.rm(input.partPath, { force: true });
          return { relativePath: rel, absolutePath: abs, alreadyExisted: true };
        }
      }
      throw new Error('Não foi possível escolher um nome livre');
    });
  }

  /**
   * fsync de um arquivo idêntico que já estava no destino. Erro de I/O ou disco cheio impede o
   * "conferido"; sem permissão de escrita (arquivo somente leitura do usuário) só gera aviso:
   * não fomos nós que escrevemos esse conteúdo agora.
   */
  private async syncExisting(abs: string): Promise<void> {
    try {
      await fsyncFile(abs);
    } catch (err) {
      const code = errnoCode(err);
      if (err instanceof DiskError && err.phase === 'open' && (code === 'EPERM' || code === 'EACCES' || code === 'EROFS')) {
        this.log.warn(`Sem permissão para fsync de ${abs} (${code}); o arquivo já existia`);
        return;
      }
      throw err;
    }
  }
}

/** Garante que `target` está dentro de `root` (defesa extra contra path traversal). */
export function ensureInside(root: string, target: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Caminho fora da pasta de destino');
  }
}
