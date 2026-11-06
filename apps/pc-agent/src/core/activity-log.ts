import path from 'node:path';
import type { ActivityEntry, TransferRoute } from './agent-state';
import { readJson, SerialQueue, writeFileAtomic } from './fs-utils';

export type { ActivityEntry, TransferRoute };

interface ActivityFile {
  version: 1;
  entries: ActivityEntry[];
  /** Contagem acumulada por mês da pasta (`AAAA-MM`), independente do limite de 200 entradas. */
  monthCounts: Record<string, number>;
  totalSaved: number;
  totalBytes: number;
}

export const ACTIVITY_MAX_ENTRIES = 200;

export class ActivityLog {
  private data: ActivityFile = { version: 1, entries: [], monthCounts: {}, totalSaved: 0, totalBytes: 0 };
  private readonly file: string;
  private readonly writes = new SerialQueue();
  private seq = 0;

  constructor(dir: string, private readonly max = ACTIVITY_MAX_ENTRIES) {
    this.file = path.join(dir, 'activity.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<ActivityFile>(this.file);
    if (stored && Array.isArray(stored.entries)) {
      this.data = {
        version: 1,
        entries: stored.entries.slice(0, this.max),
        monthCounts: stored.monthCounts ?? {},
        totalSaved: stored.totalSaved ?? 0,
        totalBytes: stored.totalBytes ?? 0,
      };
    }
  }

  /** Mais recentes primeiro. */
  entries(limit = this.max): ActivityEntry[] {
    return this.data.entries.slice(0, limit);
  }

  monthCounts(): { month: string; count: number }[] {
    return Object.entries(this.data.monthCounts)
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => b.month.localeCompare(a.month));
  }

  get totalSaved(): number {
    return this.data.totalSaved;
  }

  get totalBytes(): number {
    return this.data.totalBytes;
  }

  async add(e: Omit<ActivityEntry, 'id' | 'at'> & { at?: string }): Promise<ActivityEntry> {
    const entry: ActivityEntry = { ...e, id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`, at: e.at ?? new Date().toISOString() };
    this.data.entries.unshift(entry);
    if (this.data.entries.length > this.max) this.data.entries.length = this.max;
    if (entry.status === 'saved' && !entry.duplicate && entry.relativePath) {
      const m = /^(\d{4})\/(\d{2})\//.exec(entry.relativePath);
      if (m) {
        const key = `${m[1]}-${m[2]}`;
        this.data.monthCounts[key] = (this.data.monthCounts[key] ?? 0) + 1;
      }
      this.data.totalSaved++;
      this.data.totalBytes += entry.size;
    }
    await this.persist();
    return entry;
  }

  /** Velocidade média (bytes/s) das últimas `n` transferências concluídas (opcionalmente por rota). */
  averageSpeed(route?: TransferRoute, n = 10): number | null {
    let bytes = 0;
    let ms = 0;
    let count = 0;
    for (const e of this.data.entries) {
      if (count >= n) break;
      if (e.status !== 'saved' || !e.durationMs || !e.bytesTransferred) continue;
      if (route && e.route !== route) continue;
      bytes += e.bytesTransferred;
      ms += e.durationMs;
      count++;
    }
    return ms > 0 ? (bytes * 1000) / ms : null;
  }

  async clear(): Promise<void> {
    this.data = { version: 1, entries: [], monthCounts: {}, totalSaved: 0, totalBytes: 0 };
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    return this.writes.run(() => writeFileAtomic(this.file, snapshot, 0o644));
  }
}
