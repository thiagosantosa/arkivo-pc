// Adaptador Electron das pastas liberadas (contrato §10.4 `thumb`, §10.11 Lixeira). O core só conhece a
// interface `FsPlatformAdapter`; aqui ficam `shell.trashItem` e `nativeImage`.
import { nativeImage, NativeImage, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import { fsThumbCandidate } from '@arkivo/shared';
import type { FsPlatformAdapter } from '../core/fs-platform';

/** No Linux só abrimos imagens pequenas o bastante para decodificar inteiras na memória. */
const LINUX_MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const JPEG_QUALITIES = [82, 72, 62, 52, 42, 32, 22];

export function electronFsPlatform(platform: NodeJS.Platform = process.platform): FsPlatformAdapter {
  const linux = platform === 'linux';
  return {
    // `trashItem` usa a Lixeira do sistema (IFileOperation com "recycle" no Windows, NSFileManager no macOS,
    // gio/freedesktop no Linux). Quem chama já conferiu que o volume tem Lixeira: nunca apaga em definitivo.
    trashItem: (abs) => shell.trashItem(abs),
    canThumbnail: (mime) => {
      if (!mime) return false;
      // Linux: o `nativeImage` só abre PNG e JPEG. Windows/macOS: miniaturas do sistema (fotos, vídeos, PDF).
      if (linux) return mime === 'image/jpeg' || mime === 'image/png';
      return fsThumbCandidate(mime);
    },
    thumbnail: async (abs, size, maxBytes) => {
      let img: NativeImage;
      if (linux) {
        const st = await fsp.stat(abs);
        if (st.size > LINUX_MAX_IMAGE_BYTES) return null;
        img = nativeImage.createFromPath(abs);
      } else {
        img = await nativeImage.createThumbnailFromPath(abs, { width: size, height: size });
      }
      if (img.isEmpty()) return null;
      let { width, height } = img.getSize();
      if (Math.max(width, height) > size) {
        img = img.resize(width >= height ? { width: size, quality: 'good' } : { height: size, quality: 'good' });
        ({ width, height } = img.getSize());
      }
      // Baixa a qualidade até caber em FS_THUMB_MAX_BYTES (96 KiB).
      for (const q of JPEG_QUALITIES) {
        const jpeg = img.toJPEG(q);
        if (jpeg.length > 0 && jpeg.length <= maxBytes) return { jpeg, width, height };
      }
      return null;
    },
  };
}
