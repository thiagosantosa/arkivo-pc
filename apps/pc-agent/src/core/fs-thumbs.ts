// Pastas liberadas: miniaturas (contrato §10.4 `thumb`). Fila com até 2 gerações simultâneas e 32 esperando,
// cache em memória por (realpath, lado, mtime, tamanho). A geração em si fica no adaptador (Electron).
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { FS_THUMB_MAX_BYTES } from '@arkivo/shared';
import { FsOpError } from './fs-errors';
import type { FsPlatformAdapter } from './fs-platform';

export interface ThumbResult {
  jpeg: Buffer;
  width: number;
  height: number;
  /** ETag forte, entre aspas (vai no cabeçalho da LAN e no `FsThumbResponse.etag`). */
  etag: string;
}

export interface ThumbServiceOptions {
  platform: FsPlatformAdapter;
  concurrency?: number;
  queueMax?: number;
  /** Teto do cache (bytes de JPEG). */
  cacheMaxBytes?: number;
}

export class ThumbService {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<ThumbResult | null>>();
  /** LRU (a ordem de inserção do Map é a ordem de uso). `null` = sem prévia (não tenta de novo). */
  private readonly cache = new Map<string, ThumbResult | null>();
  private cacheBytes = 0;
  private readonly concurrency: number;
  private readonly queueMax: number;
  private readonly cacheMax: number;

  constructor(private readonly o: ThumbServiceOptions) {
    this.concurrency = o.concurrency ?? 2;
    this.queueMax = o.queueMax ?? 32;
    this.cacheMax = o.cacheMaxBytes ?? 32 * 1024 * 1024;
  }

  static key(abs: string, st: Stats, size: number): string {
    return `${abs}|${size}|${Math.floor(st.mtimeMs)}|${st.size}`;
  }

  static etag(key: string): string {
    return `"t-${createHash('sha256').update(key).digest('base64url').slice(0, 22)}"`;
  }

  /** ETag sem gerar (para responder `304` direto do cache). */
  cachedEtag(abs: string, st: Stats, size: number): string | null {
    const hit = this.cache.get(ThumbService.key(abs, st, size));
    return hit ? hit.etag : null;
  }

  get pending(): number {
    return this.waiting.length;
  }

  async get(abs: string, st: Stats, size: number): Promise<ThumbResult> {
    const key = ThumbService.key(abs, st, size);
    if (this.cache.has(key)) {
      const hit = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, hit);
      if (!hit) throw new FsOpError('NO_THUMBNAIL');
      return hit;
    }
    let p = this.inflight.get(key);
    if (!p) {
      if (this.active >= this.concurrency && this.waiting.length >= this.queueMax) {
        throw new FsOpError('BUSY', 'O PC está gerando muitas prévias. Tente de novo em instantes.');
      }
      p = this.generate(key, abs, size).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const r = await p;
    if (!r) throw new FsOpError('NO_THUMBNAIL');
    return r;
  }

  private async generate(key: string, abs: string, size: number): Promise<ThumbResult | null> {
    await this.slot();
    let result: ThumbResult | null = null;
    try {
      const img = await this.o.platform.thumbnail(abs, size, FS_THUMB_MAX_BYTES).catch(() => null);
      if (img && img.jpeg.length > 0 && img.jpeg.length <= FS_THUMB_MAX_BYTES) {
        result = { jpeg: img.jpeg, width: img.width, height: img.height, etag: ThumbService.etag(key) };
      }
    } finally {
      this.release();
    }
    this.remember(key, result);
    return result;
  }

  private remember(key: string, r: ThumbResult | null): void {
    this.cache.set(key, r);
    this.cacheBytes += r?.jpeg.length ?? 0;
    while (this.cacheBytes > this.cacheMax || this.cache.size > 5000) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cacheBytes -= this.cache.get(oldest.value)?.jpeg.length ?? 0;
      this.cache.delete(oldest.value);
    }
  }

  private slot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((r) => this.waiting.push(r));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
