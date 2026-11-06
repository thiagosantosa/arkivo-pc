// Enviar para o celular: caixa de saída do PC (contrato §11). O arquivo escolhido espera no próprio PC, por até 7 dias;
// só a lista fica em `outbox.json`, e o caminho absoluto nunca sai do PC. Nada aqui apaga ou altera o arquivo do usuário.
import { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  FS_PUSH_BLOCK_MESSAGES,
  FS_PUSH_MAX_ACTIVE,
  FS_PUSH_MAX_BYTES,
  FS_PUSH_TTL_MS,
  checkFsName,
  fsBlobCipherSize,
  fsBlockedReason,
  fsMimeFromName,
  randomFsId,
  type FsOutboxItem,
  type FsOutboxState,
  type FsSystemContext,
} from '@arkivo/shared';
import { FsOpError } from './fs-errors';
import { samePath } from './fs-resolve';
import { errnoCode, readJson, SerialQueue, writeFileAtomic } from './fs-utils';
import { Logger, silentLogger } from './types';

export const FS_OUTBOX_FILE = 'outbox.json';
/** Sem sinal do celular por este tempo, um item em `downloading` volta a `waiting` (o celular pode ter fechado). */
export const FS_OUTBOX_IDLE_MS = 15 * 60_000;
/** Quantos itens encerrados ficam na lista da tela. */
export const FS_OUTBOX_TERMINAL_KEEP = 200;

const ACTIVE: readonly FsOutboxState[] = ['waiting', 'downloading'];

export type OutboxVia = 'lan' | 'remote';

/** Como o item fica em `outbox.json`. `absPath` só existe no PC. */
export interface OutboxRecord {
  id: string;
  phoneId: string;
  phoneName: string | null;
  /** Caminho já resolvido com `realpath` no momento da escolha. */
  absPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  mime: string;
  state: FsOutboxState;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  reason?: string;
  /** O celular já dispensou o aviso de um item `changed` ou `failed`. */
  dismissed?: boolean;
  via?: OutboxVia;
}

interface OutboxFileShape {
  version: 1;
  items: OutboxRecord[];
}

/** O que a tela do PC mostra de um item. */
export interface OutboxView {
  id: string;
  name: string;
  /** Pasta do arquivo (só para o `title` da linha na tela do PC). */
  folder: string;
  size: number;
  state: FsOutboxState;
  /** De 0 a 1 enquanto `downloading`; `null` se não há como medir. */
  progress: number | null;
  phoneId: string;
  phoneName: string | null;
  via: OutboxVia | null;
  createdAt: string;
  expiresAt: string;
  reason: string | null;
}

export interface OutboxRejection {
  name: string;
  reason: string;
}

export interface OutboxAddResult {
  added: OutboxView[];
  rejected: OutboxRejection[];
}

/** Arquivo conferido, pronto para ser lido por uma das vias. */
export interface OutboxFile {
  id: string;
  abs: string;
  name: string;
  mime: string;
  size: number;
  mtimeMs: number;
  stat: Stats;
}

export interface FsOutboxOptions {
  dataDir: string;
  ctx: FsSystemContext;
  ttlMs?: number;
  maxActive?: number;
  maxBytes?: number;
  idleMs?: number;
  now?: () => number;
  logger?: Logger;
}

/**
 * Eventos: `changed` (a tela do PC atualiza a lista) e `notify` com o id do celular (a caixa de saída dele mudou por
 * ação do PC; o agente manda `fs.event outboxChanged`).
 */
export class FsOutbox extends EventEmitter {
  private items: OutboxRecord[] = [];
  private readonly live = new Map<string, { sent: number; at: number }>();
  private readonly file: string;
  private readonly writes = new SerialQueue();
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly caseInsensitive: boolean;

  constructor(private readonly o: FsOutboxOptions) {
    super();
    this.file = path.join(o.dataDir, FS_OUTBOX_FILE);
    this.now = o.now ?? Date.now;
    this.log = o.logger ?? silentLogger;
    this.caseInsensitive = o.ctx.platform !== 'linux';
  }

  // =================================================================== persistência

  async load(): Promise<void> {
    const stored = await readJson<OutboxFileShape>(this.file).catch(() => null);
    const list = Array.isArray(stored?.items) ? stored.items : [];
    this.items = list.filter(isRecord).map((r) => (r.state === 'downloading' ? { ...r, state: 'waiting' as const } : r));
    this.expireDue();
    this.prune();
  }

  private async save(): Promise<void> {
    const snap = JSON.stringify({ version: 1, items: this.items } satisfies OutboxFileShape);
    await this.writes
      .run(() => writeFileAtomic(this.file, snap, 0o600, { logger: this.log }))
      .catch((err: unknown) => this.log.warn('Falha ao gravar outbox.json', err instanceof Error ? err.message : err));
  }

  private async commit(notify?: Iterable<string>): Promise<void> {
    this.emit('changed');
    await this.save();
    for (const phoneId of new Set(notify ?? [])) this.emit('notify', phoneId);
  }

  /** Grava agora (encerramento e testes). */
  flush(): Promise<void> {
    return this.save();
  }

  // =================================================================== o que a tela do PC faz

  /** Mais recentes primeiro. */
  views(): OutboxView[] {
    return [...this.items].reverse().map((r) => this.view(r));
  }

  /** Confere cada caminho e coloca na fila de `phone`. Recusas vêm com o texto da tela, por arquivo. */
  async add(paths: readonly unknown[], phone: { id: string; name: string | null }): Promise<OutboxAddResult> {
    const added: OutboxRecord[] = [];
    const rejected: OutboxRejection[] = [];
    for (const input of paths) {
      const shown = typeof input === 'string' ? path.basename(input) : '';
      try {
        const rec = await this.buildRecord(input, phone);
        const dup = this.items.some((r) => r.phoneId === phone.id && isActive(r) && samePath(r.absPath, rec.absPath, this.caseInsensitive));
        if (dup) throw new OutboxRecusa('Este arquivo já está esperando o celular.');
        if (this.activeCount() >= (this.o.maxActive ?? FS_PUSH_MAX_ACTIVE))
          throw new OutboxRecusa(`Limite de ${this.o.maxActive ?? FS_PUSH_MAX_ACTIVE} arquivos esperando o celular.`);
        this.items.push(rec);
        added.push(rec);
      } catch (err) {
        if (!(err instanceof OutboxRecusa))
          this.log.warn('Caixa de saída: erro ao conferir arquivo', err instanceof Error ? err.message : err);
        rejected.push({ name: shown, reason: err instanceof OutboxRecusa ? err.message : 'Não foi possível ler este arquivo.' });
      }
    }
    if (added.length) await this.commit([phone.id]);
    return { added: added.map((r) => this.view(r)), rejected };
  }

  private async buildRecord(input: unknown, phone: { id: string; name: string | null }): Promise<OutboxRecord> {
    if (typeof input !== 'string' || !input || !path.isAbsolute(input)) throw new OutboxRecusa('Caminho inválido.');
    const abs = path.resolve(input);
    let lst: Stats;
    try {
      lst = await fsp.lstat(abs);
    } catch {
      throw new OutboxRecusa('Não foi possível abrir este arquivo.');
    }
    if (lst.isSymbolicLink()) throw new OutboxRecusa('Links simbólicos não podem ser enviados. Escolha o arquivo original.');
    if (lst.isDirectory()) throw new OutboxRecusa('Pastas ainda não podem ser enviadas. Escolha os arquivos que estão dentro dela.');
    if (!lst.isFile()) throw new OutboxRecusa('Só arquivos comuns podem ser enviados.');
    let real: string;
    try {
      real = await fsp.realpath(abs);
    } catch {
      throw new OutboxRecusa('Não foi possível abrir este arquivo.');
    }
    for (const p of [abs, real]) {
      const blocked = fsBlockedReason(p, this.o.ctx);
      if (blocked) throw new OutboxRecusa(FS_PUSH_BLOCK_MESSAGES[blocked]);
    }
    if (fsBlobCipherSize(lst.size) > (this.o.maxBytes ?? FS_PUSH_MAX_BYTES))
      throw new OutboxRecusa('Este arquivo passa de 2 GB, o limite para enviar ao celular.');
    const name = path.basename(real).normalize('NFC');
    if (!checkFsName(name, 'reference').ok) throw new OutboxRecusa('O nome deste arquivo não pode ser usado.');
    const t = this.now();
    return {
      id: randomFsId(),
      phoneId: phone.id,
      phoneName: phone.name,
      absPath: real,
      name,
      size: lst.size,
      mtimeMs: Math.floor(lst.mtimeMs),
      mime: fsMimeFromName(name),
      state: 'waiting',
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + (this.o.ttlMs ?? FS_PUSH_TTL_MS)).toISOString(),
      updatedAt: new Date(t).toISOString(),
    };
  }

  /** "Cancelar" num item ativo ou "Remover da lista" num encerrado. O arquivo original fica onde está. */
  async cancel(id: string): Promise<boolean> {
    const rec = this.items.find((r) => r.id === id);
    if (!rec) return false;
    const wasVisible = isActive(rec) || (!rec.dismissed && (rec.state === 'changed' || rec.state === 'failed'));
    this.items = this.items.filter((r) => r !== rec);
    this.live.delete(id);
    await this.commit(wasVisible ? [rec.phoneId] : []);
    return true;
  }

  /** Saiu da conta, desconectou o celular ou o PC foi revogado: só a lista some. */
  async clear(): Promise<void> {
    this.items = [];
    this.live.clear();
    await this.commit();
  }

  /** Um celular saiu da conta: os itens dele deixam de existir. */
  async retainPhones(phoneIds: readonly string[]): Promise<void> {
    const keep = new Set(phoneIds);
    const left = this.items.filter((r) => keep.has(r.phoneId));
    if (left.length === this.items.length) return;
    for (const r of this.items) if (!keep.has(r.phoneId)) this.live.delete(r.id);
    this.items = left;
    await this.commit();
  }

  /**
   * Chamado de tempos em tempos: expira, solta quem parou de baixar, nota arquivos que mudaram e limpa encerrados
   * antigos. Quem espera por um arquivo alterado fica sabendo pelo `fs.event`.
   */
  async tick(): Promise<void> {
    const t = this.now();
    const idle = this.o.idleMs ?? FS_OUTBOX_IDLE_MS;
    let dirty = false;
    for (const r of this.items) {
      if (r.state !== 'downloading') continue;
      const lastAt = this.live.get(r.id)?.at ?? Date.parse(r.updatedAt);
      if (t - lastAt >= idle) {
        r.state = 'waiting';
        r.updatedAt = new Date(t).toISOString();
        this.live.delete(r.id);
        dirty = true;
      }
    }
    const notify = new Set<string>(this.expireDue());
    if (notify.size) dirty = true;
    for (const phoneId of await this.sweep(() => true)) {
      notify.add(phoneId);
      dirty = true;
    }
    if (this.prune()) dirty = true;
    if (dirty) await this.commit(notify);
  }

  // =================================================================== o que o celular pede

  /** Itens deste celular: ativos e os `changed`/`failed` ainda não dispensados. Nunca os de outro celular. */
  async listFor(phoneId: string): Promise<FsOutboxItem[]> {
    let dirty = this.expireDue().length > 0;
    if ((await this.sweep((r) => r.phoneId === phoneId)).length) dirty = true;
    if (dirty) await this.commit();
    return this.items
      .filter((r) => r.phoneId === phoneId && (isActive(r) || ((r.state === 'changed' || r.state === 'failed') && !r.dismissed)))
      .map(toItem);
  }

  /** Confere o arquivo e marca como `downloading`. Lança `FsOpError`; outro celular recebe o mesmo `NOT_FOUND` de um id que não existe. */
  async beginDelivery(phoneId: string, id: string, via: OutboxVia): Promise<OutboxFile> {
    const { rec, file } = await this.check(phoneId, id);
    rec.via = via;
    this.live.set(id, { sent: rec.state === 'downloading' ? (this.live.get(id)?.sent ?? 0) : 0, at: this.now() });
    if (rec.state !== 'downloading') {
      rec.state = 'downloading';
      rec.updatedAt = new Date(this.now()).toISOString();
      await this.commit();
    }
    return file;
  }

  /** Só confere (`HEAD` na LAN): não muda o estado. */
  async inspect(phoneId: string, id: string): Promise<OutboxFile> {
    return (await this.check(phoneId, id)).file;
  }

  private async check(phoneId: string, id: string): Promise<{ rec: OutboxRecord; file: OutboxFile }> {
    const rec = this.owned(phoneId, id);
    if (this.expireDue().length) await this.commit();
    if (!isActive(rec)) throw stateError(rec);
    const before = rec.state;
    const stat = await this.verify(rec);
    if (!stat) {
      if (rec.state === before) throw new FsOpError('ROOT_UNAVAILABLE', 'Este arquivo não está acessível no PC agora.');
      await this.commit();
      throw stateError(rec);
    }
    if (!this.items.includes(rec) || !isActive(rec)) throw stateError(rec);
    return { rec, file: { id: rec.id, abs: rec.absPath, name: rec.name, mime: rec.mime, size: rec.size, mtimeMs: rec.mtimeMs, stat } };
  }

  /** "Recebi e gravei". Repetir devolve o estado atual; `transitioned` diz se mudou agora (só aí entra no histórico). */
  async done(phoneId: string, id: string): Promise<{ item: FsOutboxItem; transitioned: boolean }> {
    const rec = this.owned(phoneId, id);
    if (!isActive(rec)) return { item: toItem(rec), transitioned: false };
    this.finish(rec, 'delivered');
    await this.commit();
    return { item: toItem(rec), transitioned: true };
  }

  /** "Não quero". Em `changed`/`failed` só dispensa o aviso; em qualquer outro estado final, nada muda. */
  async decline(phoneId: string, id: string): Promise<{ item: FsOutboxItem; transitioned: boolean }> {
    const rec = this.owned(phoneId, id);
    if (isActive(rec)) {
      this.finish(rec, 'declined');
      await this.commit();
      return { item: toItem(rec), transitioned: true };
    }
    if ((rec.state === 'changed' || rec.state === 'failed') && !rec.dismissed) {
      rec.dismissed = true;
      await this.commit();
    }
    return { item: toItem(rec), transitioned: false };
  }

  // =================================================================== o que as vias informam

  isActive(id: string): boolean {
    const rec = this.items.find((r) => r.id === id);
    return !!rec && isActive(rec);
  }

  /** Bytes já entregues (LAN) ou já enviados ao servidor (remoto). Só avisa a tela a cada 1%. */
  progress(id: string, sent: number): void {
    const rec = this.items.find((r) => r.id === id);
    if (!rec || rec.state !== 'downloading') return;
    const prev = this.live.get(id);
    this.live.set(id, { sent, at: this.now() });
    const pct = (n: number) => (rec.size ? Math.floor((n / rec.size) * 100) : 100);
    if (!prev || pct(prev.sent) !== pct(sent)) this.emit('changed');
  }

  /** A entrega falhou por algo passageiro (rede, servidor cheio): o item volta a esperar. */
  async release(id: string): Promise<void> {
    const rec = this.items.find((r) => r.id === id);
    if (!rec || rec.state !== 'downloading') return;
    rec.state = 'waiting';
    rec.updatedAt = new Date(this.now()).toISOString();
    this.live.delete(id);
    await this.commit();
  }

  /** O arquivo mudou enquanto era preparado. */
  async markChanged(id: string): Promise<void> {
    const rec = this.items.find((r) => r.id === id);
    if (!rec || !isActive(rec)) return;
    this.finish(rec, 'changed');
    await this.commit([rec.phoneId]);
  }

  // =================================================================== internos

  private owned(phoneId: string, id: string): OutboxRecord {
    const rec = this.items.find((r) => r.id === id);
    if (!rec || rec.phoneId !== phoneId) throw new FsOpError('NOT_FOUND', 'Este arquivo não está mais disponível.');
    return rec;
  }

  private activeCount(): number {
    return this.items.reduce((n, r) => n + (isActive(r) ? 1 : 0), 0);
  }

  private finish(rec: OutboxRecord, state: FsOutboxState, reason?: string): void {
    rec.state = state;
    rec.updatedAt = new Date(this.now()).toISOString();
    if (reason) rec.reason = reason;
    this.live.delete(rec.id);
  }

  /**
   * O arquivo continua sendo o escolhido? Tamanho ou data diferentes → `changed`; apagado, trocado por outra coisa ou
   * agora bloqueado → `failed`. Devolve `null` também em erro passageiro (unidade desconectada, sem permissão), sem
   * mudar o estado: o arquivo pode voltar.
   */
  private async verify(rec: OutboxRecord): Promise<Stats | null> {
    let lst: Stats;
    try {
      lst = await fsp.lstat(rec.absPath);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        const folderThere = await fsp.stat(path.dirname(rec.absPath)).then(
          () => true,
          () => false,
        );
        if (folderThere) this.finish(rec, 'failed', 'O arquivo não está mais no PC.');
      }
      return null;
    }
    if (!lst.isFile()) {
      this.finish(rec, 'failed', 'O arquivo foi trocado por outra coisa no PC.');
      return null;
    }
    if (lst.size !== rec.size || Math.floor(lst.mtimeMs) !== rec.mtimeMs) {
      this.finish(rec, 'changed');
      return null;
    }
    let real: string;
    try {
      real = await fsp.realpath(rec.absPath);
    } catch {
      return null;
    }
    // Uma pasta do caminho virou link depois da escolha: o arquivo que abriria já não é o escolhido.
    if (!samePath(real, rec.absPath, this.caseInsensitive) || fsBlockedReason(real, this.o.ctx)) {
      this.finish(rec, 'failed', 'O caminho deste arquivo mudou no PC.');
      return null;
    }
    return lst;
  }

  /** Confere os itens em `waiting`. Devolve os celulares afetados. */
  private async sweep(match: (r: OutboxRecord) => boolean): Promise<string[]> {
    const affected: string[] = [];
    await Promise.all(
      this.items
        .filter((r) => r.state === 'waiting' && match(r))
        .map(async (r) => {
          await this.verify(r).catch(() => null);
          if (r.state !== 'waiting') affected.push(r.phoneId);
        }),
    );
    return affected;
  }

  /** Marca como `expired` o que passou do prazo. Devolve os celulares afetados. */
  private expireDue(): string[] {
    const t = this.now();
    const affected: string[] = [];
    for (const r of this.items) {
      if (r.state === 'waiting' && Date.parse(r.expiresAt) <= t) {
        this.finish(r, 'expired');
        affected.push(r.phoneId);
      }
    }
    return affected;
  }

  /** Tira da lista os encerrados há mais tempo que o prazo e os mais antigos acima do limite. */
  private prune(): boolean {
    const t = this.now();
    const ttl = this.o.ttlMs ?? FS_PUSH_TTL_MS;
    let terminal = this.items.filter((r) => !isActive(r)).length;
    const before = this.items.length;
    this.items = this.items.filter((r) => {
      if (isActive(r)) return true;
      if (t - Date.parse(r.updatedAt) > ttl || terminal > FS_OUTBOX_TERMINAL_KEEP) {
        terminal--;
        return false;
      }
      return true;
    });
    return this.items.length !== before;
  }

  private view(r: OutboxRecord): OutboxView {
    const sent = this.live.get(r.id)?.sent;
    return {
      id: r.id,
      name: r.name,
      folder: path.dirname(r.absPath),
      size: r.size,
      state: r.state,
      progress: r.state === 'downloading' ? (r.size ? Math.min(1, (sent ?? 0) / r.size) : 1) : null,
      phoneId: r.phoneId,
      phoneName: r.phoneName,
      via: r.via ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      reason: r.reason ?? null,
    };
  }
}

/** Recusa ao escolher um arquivo: a mensagem já é o texto da tela. */
class OutboxRecusa extends Error {}

function isActive(r: OutboxRecord): boolean {
  return ACTIVE.includes(r.state);
}

function isRecord(r: unknown): r is OutboxRecord {
  const x = r as Partial<OutboxRecord> | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.phoneId === 'string' &&
    typeof x.absPath === 'string' &&
    typeof x.size === 'number' &&
    typeof x.state === 'string'
  );
}

function toItem(r: OutboxRecord): FsOutboxItem {
  const item: FsOutboxItem = {
    id: r.id,
    name: r.name,
    size: r.size,
    mime: r.mime,
    mtime: new Date(r.mtimeMs).toISOString(),
    state: r.state,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
  if (r.reason) item.reason = r.reason;
  return item;
}

function stateError(rec: OutboxRecord): FsOpError {
  if (rec.state === 'changed') return new FsOpError('CHANGED', 'O arquivo mudou no PC depois de ser escolhido. Envie de novo.');
  return new FsOpError('NOT_FOUND', rec.reason ?? 'Este arquivo não está mais disponível.');
}
