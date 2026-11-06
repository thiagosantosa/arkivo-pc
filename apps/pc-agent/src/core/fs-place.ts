// Pastas liberadas: colocar no destino um arquivo enviado pelo celular (LAN e remoto, §10.4 `upload`).
// O `.part` já passou por fsync e teve o SHA-256 conferido; aqui vem a regra de conflito, o `rename` atômico
// (mesmo volume: o `.part` fica dentro da raiz) e o fsync dos diretórios, como no backup (§6).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  FS_PARTS_DIR_NAME,
  FS_RESERVED_PREFIX,
  fsCollisionName,
  isFsDriveRoot,
  joinFsPath,
  type FsConflictPolicy,
  type FsPlatform,
  type FsUploadResult,
} from '@arkivo/shared';
import { driveRootWriteError, FsOpError, fsErrorFromErrno } from './fs-errors';
import { lstatOrNull, type FsService } from './fs-service';
import { errnoCode, fsyncDir, mkdirDurable, renameWithRetry } from './fs-utils';

export type UploadPolicy = Exclude<FsConflictPolicy, 'skip'>;

/**
 * Confere o destino antes de receber (sem gastar banda): `fail` com nome em uso → `CONFLICT`; `replace` sem Lixeira →
 * `TRASH_UNAVAILABLE`; raiz de unidade onde o Windows não deixa gravar arquivo (`C:\` sem administrador) →
 * `PERMISSION_DENIED` com mensagem clara (§10.11 [2026-11-06]).
 */
export async function precheckUpload(svc: FsService, rootId: string, dirRel: string, name: string, policy: UploadPolicy): Promise<void> {
  const { dir, abs } = await svc.resolver.newChild(rootId, dirRel, name);
  if (isFsDriveRoot(dir.abs, svc.fsPlatform)) await probeDriveRootWrite(dir.abs, svc.fsPlatform);
  const existing = await lstatOrNull(abs);
  if (!existing) return;
  if (policy === 'fail') throw new FsOpError('CONFLICT');
  if (policy === 'replace') {
    if (existing.isDirectory()) throw new FsOpError('CONFLICT', 'Já existe uma pasta com esse nome.');
    const vol = await svc.volumes.info(path.dirname(abs)).catch(() => null);
    if (!vol?.trashAvailable) throw new FsOpError('TRASH_UNAVAILABLE');
  }
}

export interface PlaceUploadInput {
  rootId: string;
  dirRel: string;
  name: string;
  policy: UploadPolicy;
  partPath: string;
  hash: string;
}

/** Move o `.part` conferido para o destino. Serializado com as outras mudanças (`svc.mutations`). */
export function placeUpload(svc: FsService, i: PlaceUploadInput): Promise<FsUploadResult> {
  return svc.mutations.run(async () => {
    const { dir, abs } = await svc.resolver.newChild(i.rootId, i.dirRel, i.name);
    let finalName = path.basename(abs);
    let dest = abs;
    const existing = await lstatOrNull(dest);
    if (existing) {
      if (i.policy === 'fail') throw new FsOpError('CONFLICT');
      if (i.policy === 'replace') {
        if (existing.isDirectory()) throw new FsOpError('CONFLICT', 'Já existe uma pasta com esse nome.');
        // O antigo vai para a Lixeira (nunca é apagado em definitivo); sem Lixeira → TRASH_UNAVAILABLE.
        await svc.trashAbs(dest);
      } else {
        for (let n = 2; ; n++) {
          if (n > 9999) throw new FsOpError('CONFLICT');
          finalName = fsCollisionName(i.name, n);
          dest = path.join(dir.abs, finalName);
          if (!(await lstatOrNull(dest))) break;
        }
      }
    }
    if (!svc.resolver.allowed(dir.rootReal, dest)) throw new FsOpError('FORBIDDEN_PATH');
    try {
      await renameWithRetry(i.partPath, dest);
    } catch (err) {
      throw driveRootWriteError(err, dir.abs, svc.fsPlatform) ?? fsErrorFromErrno(err, 'write');
    }
    await fsyncDir(dir.abs);
    await fsyncDir(path.dirname(i.partPath));
    const st = await fsp.stat(dest);
    const nfc = finalName.normalize('NFC');
    return {
      rootId: i.rootId,
      path: joinFsPath(i.dirRel, nfc),
      entry: svc.entryFor(nfc, st),
      verifiedHash: i.hash,
      renamed: nfc !== i.name,
    };
  });
}

/**
 * `<raiz>/.arkivo-fs-parciais` (mesmo volume do destino, para o `rename` ser atômico). Criada com fsync do pai
 * e, no Windows, com o atributo oculto (melhor esforço).
 */
export async function ensurePartsDir(rootReal: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const dir = path.join(rootReal, FS_PARTS_DIR_NAME);
  const existed = await lstatOrNull(dir);
  try {
    await mkdirDurable(dir, (d) => fsyncDir(d));
  } catch (err) {
    // Sem a pasta de parciais não há envio nesta raiz. Na raiz da unidade (`C:\` num PC sem permissão de criar pasta
    // ali), o motivo é a permissão, não "arquivo aberto".
    const code = errnoCode(err);
    if (code === 'EPERM' || code === 'EACCES') {
      const driveRoot = platform === 'win32' && isFsDriveRoot(rootReal, 'windows');
      throw new FsOpError('PERMISSION_DENIED', driveRoot ? PARTS_DIR_DENIED_MESSAGE : 'O sistema não deixou o Arkivo gravar nesta pasta liberada.');
    }
    throw fsErrorFromErrno(err, 'write');
  }
  if (!existed && platform === 'win32') {
    await new Promise<void>((r) => execFile('attrib.exe', ['+h', dir], { windowsHide: true, timeout: 5_000 }, () => r()));
  }
  return dir;
}

/** A raiz da unidade liberada inteira não aceita nem a pasta oculta dos envios (`.arkivo-fs-parciais`). */
export const PARTS_DIR_DENIED_MESSAGE =
  'O Windows não deixou o Arkivo preparar o envio na raiz deste disco. No PC, libere uma pasta dentro dele em vez do disco inteiro.';

/**
 * A raiz de uma unidade aceita arquivo novo? Cria e apaga na hora um arquivo vazio com o prefixo reservado
 * (`.arkivo-`, nunca listado). `EPERM`/`EACCES` → `PERMISSION_DENIED` com `DRIVE_ROOT_WRITE_MESSAGE`. Outros erros
 * passam (o envio falha depois, no lugar de sempre).
 */
export async function probeDriveRootWrite(dirAbs: string, platform: FsPlatform): Promise<void> {
  const probe = path.join(dirAbs, `${FS_RESERVED_PREFIX}teste-${randomBytes(6).toString('hex')}`);
  let fh: FileHandle;
  try {
    fh = await fsp.open(probe, 'wx');
  } catch (err) {
    const denied = driveRootWriteError(err, dirAbs, platform);
    if (denied) throw denied;
    return;
  }
  await fh.close().catch(() => undefined);
  await fsp.rm(probe, { force: true }).catch(() => undefined);
}

/** Apaga a pasta de parciais se ficou vazia. */
export async function removePartsDirIfEmpty(rootReal: string): Promise<void> {
  const dir = path.join(rootReal, FS_PARTS_DIR_NAME);
  try {
    if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
  } catch {
    /* não existe ou não está vazia */
  }
}
