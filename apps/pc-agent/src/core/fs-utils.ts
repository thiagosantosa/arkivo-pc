import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Logger, silentLogger } from './types';

// =====================================================================================
// Durabilidade
//
// O celular apaga o original quando o PC diz "conferido". Por isso "conferido" só pode ser dito
// depois que o arquivo está no disco de verdade, não só no cache de páginas do SO. A ordem é:
//   escrever → fh.sync() → fechar → SHA-256 → rename → fsync do diretório → responder/reportar.
// =====================================================================================

/** Erro do disco (não da rede) ao gravar um arquivo, com a fase em que aconteceu. */
export class DiskError extends Error {
  constructor(
    /** `open`/`write`: o que já estava no arquivo continua válido. `sync`/`close`: o conteúdo não é confiável. */
    readonly phase: 'open' | 'write' | 'sync' | 'close',
    override readonly cause: unknown,
  ) {
    super(`Erro de disco (${phase}): ${errnoCode(cause) ?? (cause instanceof Error ? cause.message : String(cause))}`);
    this.name = 'DiskError';
  }

  get code(): string | undefined {
    return errnoCode(this.cause);
  }
}

export function errnoCode(err: unknown): string | undefined {
  if (err instanceof DiskError) return err.code;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Disco (ou cota) cheio: `ENOSPC`/`EDQUOT`, direto ou dentro de um `DiskError`. */
export function isNoSpace(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOSPC' || code === 'EDQUOT';
}

export interface FsyncDirOptions {
  logger?: Logger;
  /** Só para testes (padrão: `process.platform`). */
  platform?: NodeJS.Platform;
}

const dirSyncWarned = new Set<string>();

/**
 * fsync de um diretório: torna duráveis as entradas criadas, apagadas ou renomeadas nele
 * (sem isso, depois de faltar energia, um `rename` já "feito" pode desaparecer).
 *
 * - **POSIX** (Linux/macOS): `open(dir, 'r')` + `fsync`. No macOS o `fsync` não esvazia o cache
 *   do próprio disco (`F_FULLFSYNC`, que o Node não expõe); vale o mesmo que para os arquivos.
 * - **Windows**: abrir o diretório só para leitura e chamar `fsync` dá `EPERM` (o `FlushFileBuffers`
 *   exige acesso de escrita). Abrir com `'r+'` funciona: o libuv usa `FILE_FLAG_BACKUP_SEMANTICS`
 *   e o handle recebe `GENERIC_WRITE`, então `fh.sync()` vira `FlushFileBuffers` no diretório, que no
 *   NTFS grava o índice do diretório e o journal ($LogFile) até aquela mudança. Nada é escrito no
 *   diretório e o compartilhamento é total (`FILE_SHARE_READ|WRITE|DELETE`), então não bloqueia ninguém.
 *   Se o volume não deixar (FAT/exFAT, rede, permissão), vira no-op: o NTFS já faz journal dos
 *   metadados e o lazy writer grava o journal em poucos segundos.
 *
 * **Nunca lança.** Falha vira um aviso (uma vez por diretório e código de erro) e `false`: o dado do
 * arquivo já passou por `fh.sync()` antes, e derrubar o recebimento por causa disso trocaria um risco
 * pequeno (perder a entrada do diretório num corte de energia) por nunca conseguir salvar nada.
 */
export async function fsyncDir(dir: string, opts: FsyncDirOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  let fh: FileHandle | null = null;
  try {
    fh = await fsp.open(dir, platform === 'win32' ? 'r+' : 'r');
    await fh.sync();
    return true;
  } catch (err) {
    const code = errnoCode(err) ?? 'erro';
    const key = `${path.resolve(dir)}|${code}`;
    if (!dirSyncWarned.has(key)) {
      dirSyncWarned.add(key);
      (opts.logger ?? silentLogger).warn(`fsync do diretório indisponível (${code}) em ${dir}; seguindo sem ele`);
    }
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Função que faz o fsync de um diretório (injetável para testes). */
export type SyncDir = (dir: string) => Promise<unknown>;

/** `open(file, 'r+')` + `fh.sync()` + `close`. Lança `DiskError` se falhar. */
export async function fsyncFile(file: string): Promise<void> {
  let fh: FileHandle;
  try {
    fh = await fsp.open(file, 'r+');
  } catch (err) {
    throw new DiskError('open', err);
  }
  try {
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw new DiskError('sync', err);
  }
  try {
    await fh.close();
  } catch (err) {
    throw new DiskError('close', err);
  }
}

/**
 * `mkdir -p` durável: cria o que faltar e faz fsync do pai de cada diretório criado
 * (senão a pasta nova `AAAA/MM` pode sumir num corte de energia, levando o arquivo junto).
 * O próprio `dir` não é sincronizado aqui: quem grava nele faz isso depois do `rename`.
 */
export async function mkdirDurable(dir: string, syncDir: SyncDir): Promise<void> {
  const first = await fsp.mkdir(dir, { recursive: true });
  if (!first) return;
  // No Windows o Node devolve o caminho no namespace `\\?\` (ou `\\?\UNC\`).
  const top = path.resolve(first.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''));
  const chain: string[] = [];
  let matched = false;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    chain.unshift(d);
    if (d.toLowerCase() === top.toLowerCase()) {
      matched = true;
      break;
    }
    if (path.dirname(d) === d) break;
  }
  if (!matched) {
    // Formato inesperado: sincroniza só o pai imediato em vez de subir até a raiz do disco.
    await syncDir(path.dirname(path.resolve(dir)));
    return;
  }
  // chain = [primeiro criado, ..., dir]; pais a sincronizar = pai do primeiro + todos menos o último.
  for (const d of [path.dirname(chain[0]), ...chain.slice(0, -1)]) await syncDir(d);
}

export interface DurableWriteOptions {
  /** `'a'` acrescenta no fim; `'w'` recria; `'r+'` escreve a partir de `start`. */
  flags: 'a' | 'w' | 'r+';
  start?: number;
  mode?: number;
}

/**
 * Passa `streams` (origem + transforms) para `file` e só resolve depois de **escrever tudo →
 * `fh.sync()` → `close()`**. O `fsync` roda no `final` do destino, então o `pipeline` só termina
 * com os dados no disco.
 *
 * Erros do disco viram `DiskError` com a fase (`open`/`write`/`sync`/`close`); erros da origem
 * (conexão caiu) e dos transforms saem como vieram. Se a origem falhar, não há fsync: o que foi
 * gravado fica para retomada e é conferido (com fsync) no fim.
 */
export async function writeStreamDurable(file: string, streams: NodeJS.ReadableStream[], opts: DurableWriteOptions): Promise<void> {
  let fh: FileHandle;
  try {
    fh = await fsp.open(file, opts.flags, opts.mode);
  } catch (err) {
    throw new DiskError('open', err);
  }
  // `null` = posição atual do arquivo (acrescenta no modo 'a').
  let pos: number | null = opts.flags === 'a' ? null : (opts.start ?? 0);
  const writeAll = async (buf: Buffer): Promise<void> => {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off, pos);
      off += bytesWritten;
      if (pos !== null) pos += bytesWritten;
    }
  };
  const sink = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk: Buffer, _enc, cb) {
      writeAll(chunk).then(
        () => cb(),
        (err: unknown) => cb(new DiskError('write', err)),
      );
    },
    writev(chunks, cb) {
      writeAll(Buffer.concat(chunks.map((c) => c.chunk as Buffer))).then(
        () => cb(),
        (err: unknown) => cb(new DiskError('write', err)),
      );
    },
    final(cb) {
      fh.sync().then(
        () => cb(),
        (err: unknown) => cb(new DiskError('sync', err)),
      );
    },
  });
  try {
    await pipeline([...streams, sink]);
  } catch (err) {
    // close() espera as operações pendentes no handle terminarem.
    await fh.close().catch(() => undefined);
    throw err;
  }
  try {
    await fh.close();
  } catch (err) {
    throw new DiskError('close', err);
  }
}

export interface AtomicWriteOptions {
  logger?: Logger;
  /** Só para testes (padrão: `fsyncDir`). */
  syncDir?: SyncDir;
}

/**
 * Grava um arquivo de forma atômica **e durável**: tmp → `fh.sync()` → close → rename (com
 * tentativas no Windows, por causa de antivírus/indexador) → fsync do diretório.
 * Num corte de energia fica o conteúdo antigo inteiro ou o novo inteiro, nunca um arquivo truncado.
 */
export async function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600, opts: AtomicWriteOptions = {}): Promise<void> {
  const dir = path.dirname(file);
  const syncDir: SyncDir = opts.syncDir ?? ((d) => fsyncDir(d, { logger: opts.logger }));
  await mkdirDurable(dir, syncDir);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w', mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
    await fh.close();
    await renameWithRetry(tmp, file, 5, 30);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDir(dir);
}

/** `rename` com tentativas: no Windows, antivírus/indexador às vezes seguram o arquivo por alguns ms. */
export async function renameWithRetry(from: string, to: string, retries = 5, baseDelayMs = 50): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (i < retries && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Serializa operações assíncronas (uma de cada vez, na ordem). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
