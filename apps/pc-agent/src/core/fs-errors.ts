// Pastas liberadas (contrato §10.3): erro de operação com o código do contrato e tradução de `errno`.
import { fsError, isFsDriveRoot, type FsErrorBody, type FsErrorCode, type FsPlatform } from '@arkivo/shared';
import { errnoCode } from './fs-utils';

/** Erro de uma operação de pastas liberadas; vira `{ error: { code, message } }` nas duas vias. */
export class FsOpError extends Error {
  readonly body: FsErrorBody;
  constructor(code: FsErrorCode, message?: string) {
    const body = fsError(code, message);
    super(body.message);
    this.name = 'FsOpError';
    this.body = body;
  }
  get code(): FsErrorCode {
    return this.body.code;
  }
}

export function fsFail(code: FsErrorCode, message?: string): never {
  throw new FsOpError(code, message);
}

export type FsOpKind = 'read' | 'write';

/**
 * Traduz um erro do sistema de arquivos para o código do contrato.
 * `EPERM` em operação de escrita no Windows quase sempre é "arquivo aberto em outro programa" (§10.11) → `BUSY`.
 */
export function fsErrorFromErrno(err: unknown, kind: FsOpKind = 'read', platform: NodeJS.Platform = process.platform): FsOpError {
  if (err instanceof FsOpError) return err;
  const code = errnoCode(err);
  switch (code) {
    case 'ENOENT':
      return new FsOpError('NOT_FOUND');
    case 'ENOTDIR':
      return new FsOpError('NOT_A_DIRECTORY');
    case 'EISDIR':
      return new FsOpError('IS_A_DIRECTORY');
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new FsOpError('CONFLICT');
    case 'EBUSY':
    case 'ETXTBSY':
      return new FsOpError('BUSY', 'Feche o arquivo no PC e tente de novo.');
    case 'EPERM':
      if (kind === 'write' && platform === 'win32') return new FsOpError('BUSY', 'Feche o arquivo no PC e tente de novo.');
      return new FsOpError('PERMISSION_DENIED', permissionMessage(platform));
    case 'EACCES':
    case 'EROFS':
      return new FsOpError('PERMISSION_DENIED', permissionMessage(platform));
    case 'ENOSPC':
    case 'EDQUOT':
      return new FsOpError('NO_SPACE');
    case 'EXDEV':
      return new FsOpError('CROSS_DEVICE');
    case 'ENAMETOOLONG':
      return new FsOpError('INVALID_NAME', 'Nome ou caminho comprido demais para este disco.');
    case 'ENODEV':
    case 'ENXIO':
    case 'EHOSTDOWN':
    case 'ENETUNREACH':
    case 'ESTALE':
      return new FsOpError('ROOT_UNAVAILABLE');
    default:
      return new FsOpError('INTERNAL');
  }
}

/**
 * Gravar arquivo direto na raiz da unidade do sistema (`C:\`) costuma exigir administrador; criar pasta ali, não
 * (§10.11 [2026-11-06]). Mensagem para o celular, sem caminho.
 */
export const DRIVE_ROOT_WRITE_MESSAGE = 'O Windows não deixa gravar arquivos direto na raiz do disco. Escolha uma pasta dentro dele.';
export const DRIVE_ROOT_MKDIR_MESSAGE = 'O Windows não deixou criar a pasta direto na raiz do disco. Escolha uma pasta dentro dele.';

/**
 * Permissão negada (`EPERM`/`EACCES`) numa pasta que é a raiz de uma unidade do Windows → `PERMISSION_DENIED` com a
 * mensagem certa. Fora disso, `null` (vale a tradução de sempre: no Windows, `EPERM` de escrita costuma ser arquivo
 * aberto em outro programa). Na raiz da unidade não há "arquivo aberto" a culpar: é a permissão da raiz.
 */
export function driveRootWriteError(err: unknown, dirAbs: string, platform: FsPlatform, message = DRIVE_ROOT_WRITE_MESSAGE): FsOpError | null {
  const code = errnoCode(err);
  if (code !== 'EPERM' && code !== 'EACCES') return null;
  if (!isFsDriveRoot(dirAbs, platform)) return null;
  return new FsOpError('PERMISSION_DENIED', message);
}

function permissionMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'O macOS não deixou o Arkivo mexer neste item.';
  if (platform === 'linux') return 'O sistema não deixou o Arkivo mexer neste item.';
  return 'O Windows não deixou o Arkivo mexer neste item.';
}

/** Qualquer erro → corpo do contrato (desconhecido = `INTERNAL`, sem vazar detalhes internos). */
export function toFsErrorBody(err: unknown, kind: FsOpKind = 'read'): FsErrorBody {
  return fsErrorFromErrno(err, kind).body;
}
