// Pastas liberadas: limites por celular (§10.10) e idempotência por `(phoneId, requestId)` (§10.4).
import { FS_IDEMPOTENCY_TTL_MS, type FsErrorCode, type FsRpcResult } from '@arkivo/shared';

/** Pedidos por segundo por chave (janela deslizante de 1 s). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** `true` = pode; registra o pedido. */
  take(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < 1000);
    if (list.length >= this.perSecond) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 1000) this.prune(t);
    return true;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < 1000)) this.hits.delete(k);
  }
}

/** Quantos ao mesmo tempo por chave (downloads LAN, envios remotos). */
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Devolve a função que libera, ou `null` se já está no máximo. */
  acquire(key: string): (() => void) | null {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return null;
    this.active.set(key, n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }

  count(key: string): number {
    return this.active.get(key) ?? 0;
  }
}

/** Erros que não ficam guardados: tentar de novo pode dar certo (ocupado, desligado, disco desconectado...). */
const TRANSIENT: readonly FsErrorCode[] = ['BUSY', 'RATE_LIMITED', 'INTERNAL', 'ROOT_UNAVAILABLE', 'FS_DISABLED', 'NO_SPACE'];

/**
 * Resposta guardada por `(phoneId, requestId)` durante 10 min, em memória. O mesmo `requestId` de novo (por
 * qualquer via) devolve a resposta guardada sem executar; ainda em execução → `BUSY`.
 */
export class IdempotencyCache {
  private readonly done = new Map<string, { at: number; result: FsRpcResult }>();
  private readonly running = new Set<string>();

  constructor(
    private readonly ttlMs = FS_IDEMPOTENCY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  static key(phoneId: string, requestId: string): string {
    return `${phoneId}|${requestId}`;
  }

  async run(key: string, fn: () => Promise<FsRpcResult>): Promise<FsRpcResult> {
    this.prune();
    const hit = this.done.get(key);
    if (hit) return hit.result;
    if (this.running.has(key)) return { ok: false, error: { code: 'BUSY', message: 'Este pedido ainda está sendo feito no PC.' } };
    this.running.add(key);
    try {
      const result = await fn();
      if (result.ok || !TRANSIENT.includes(result.error.code)) this.done.set(key, { at: this.now(), result });
      return result;
    } finally {
      this.running.delete(key);
    }
  }

  get size(): number {
    return this.done.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.done) if (t - v.at > this.ttlMs) this.done.delete(k);
  }
}
