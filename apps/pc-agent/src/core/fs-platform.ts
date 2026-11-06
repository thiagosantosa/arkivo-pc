// Pastas liberadas: o que depende do Electron fica atrás desta interface, para o core rodar (e ser testado)
// sem Electron. O adaptador real está em `src/main/fs-electron.ts`.
import { FsOpError } from './fs-errors';

export interface ThumbnailImage {
  /** JPEG pronto (lado maior ≤ `size`, ≤ `maxBytes`). */
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface FsPlatformAdapter {
  /**
   * Manda para a Lixeira do sistema (`shell.trashItem`). Quem chama já conferiu que o volume tem Lixeira
   * (§10.11); o adaptador **nunca** apaga em definitivo.
   */
  trashItem(absPath: string): Promise<void>;
  /** Este tipo de arquivo pode ter miniatura nesta plataforma? (Linux: só imagens que o `nativeImage` abre.) */
  canThumbnail(mime: string | null): boolean;
  /** Gera a miniatura JPEG, ou `null` se não houver prévia para o arquivo. */
  thumbnail(absPath: string, size: number, maxBytes: number): Promise<ThumbnailImage | null>;
}

/** Sem Electron (testes, ferramentas): não apaga nada e não gera miniaturas. */
export const headlessFsPlatform: FsPlatformAdapter = {
  trashItem: () => Promise.reject(new FsOpError('TRASH_UNAVAILABLE')),
  canThumbnail: () => false,
  thumbnail: () => Promise.resolve(null),
};
