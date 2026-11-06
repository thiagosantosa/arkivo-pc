// Pastas liberadas: auditoria local "O que o celular fez" (contrato §10.10). Fica só no PC (`fs-audit.json`).
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomFsId, type FsAuditEntry } from '@arkivo/shared';
import { readJson, SerialQueue, writeFileAtomic } from './fs-utils';
import { Logger, silentLogger } from './types';

export const FS_AUDIT_FILE = 'fs-audit.json';
export const FS_AUDIT_MAX_ENTRIES = 5000;
export const FS_AUDIT_MAX_AGE_MS = 90 * 24 * 3600_000;
/** Navegação (`list`, `stat`, `thumb`) vira uma entrada `browse` por celular a cada 10 min. */
export const FS_AUDIT_BROWSE_WINDOW_MS = 10 * 60_000;

interface AuditFile {
  version: 1;
  entries: FsAuditEntry[];
}

export interface FsAuditOptions {
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
  /** Junta gravações próximas (navegação gera muitas). */
  flushDelayMs?: number;
  logger?: Logger;
}

export type FsAuditInput = Omit<FsAuditEntry, 'id' | 'at'>;

/** Eventos: `changed` (a tela do PC atualiza a lista). */
export class FsAuditLog extends EventEmitter {
  private list: FsAuditEntry[] = [];
  private readonly file: string;
  private readonly writes = new SerialQueue();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    dir: string,
    private readonly o: FsAuditOptions = {},
  ) {
    super();
    this.file = path.join(dir, FS_AUDIT_FILE);
    this.now = o.now ?? Date.now;
    this.log = o.logger ?? silentLogger;
  }

  async load(): Promise<void> {
    const stored = await readJson<AuditFile>(this.file).catch(() => null);
    this.list = Array.isArray(stored?.entries) ? stored.entries.filter((e) => e && typeof e.at === 'string') : [];
    this.prune();
  }

  /** Mais recentes primeiro. */
  entries(limit = this.o.maxEntries ?? FS_AUDIT_MAX_ENTRIES): FsAuditEntry[] {
    return this.list.slice(0, limit);
  }

  record(e: FsAuditInput): FsAuditEntry {
    const entry: FsAuditEntry = { ...e, id: randomFsId(9), at: new Date(this.now()).toISOString() };
    this.list.unshift(entry);
    this.prune();
    this.changed();
    return entry;
  }

  /** Navegação agrupada: uma entrada `browse` por celular a cada 10 min (soma `count`). */
  browse(phoneId: string, phoneName: string | null, via: FsAuditEntry['via']): void {
    const t = this.now();
    const recent = this.list.find((e) => e.op === 'browse' && e.phoneId === phoneId && t - Date.parse(e.at) < FS_AUDIT_BROWSE_WINDOW_MS);
    if (recent) {
      recent.count++;
      if (recent.via !== via) recent.via = via;
      this.changed();
      return;
    }
    this.record({
      phoneId,
      phoneName,
      via,
      op: 'browse',
      rootId: null,
      rootLabel: null,
      path: null,
      toPath: null,
      count: 1,
      bytes: null,
      result: 'ok',
    });
  }

  async clear(): Promise<void> {
    this.list = [];
    this.changed();
    await this.flush();
  }

  /** Grava agora o que estiver pendente. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snap = JSON.stringify({ version: 1, entries: this.list } satisfies AuditFile);
    await this.writes.run(() => writeFileAtomic(this.file, snap, 0o600, { logger: this.log }));
  }

  private prune(): void {
    const max = this.o.maxEntries ?? FS_AUDIT_MAX_ENTRIES;
    const oldest = this.now() - (this.o.maxAgeMs ?? FS_AUDIT_MAX_AGE_MS);
    this.list = this.list.filter((e) => Date.parse(e.at) >= oldest);
    if (this.list.length > max) this.list.length = max;
  }

  private changed(): void {
    this.emit('changed');
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err: unknown) => this.log.warn('Falha ao gravar fs-audit.json', err instanceof Error ? err.message : err));
    }, this.o.flushDelayMs ?? 1_000);
    this.timer.unref?.();
  }
}
