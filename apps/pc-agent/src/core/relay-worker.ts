import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import type { Transfer } from '@arkivo/shared';
import { ApiClient, ApiError } from './api-client';
import { DiskError, isNoSpace } from './fs-utils';
import { ONE_GIB } from './lan-server';
import { PlaceResult, Storage } from './storage';
import { Clock, Logger, silentLogger } from './types';

export interface RelayWorkerOptions {
  api: ApiClient;
  storage: Storage;
  minFreeMarginBytes?: number;
  freeBytes?: () => Promise<number>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  now?: Clock;
  logger?: Logger;
}

export interface RelayProgressEvent {
  transferId: string;
  fileId: string;
  name: string;
  takenAt: string | null;
  received: number;
  total: number;
}

export interface RelayCompletedEvent {
  transferId: string;
  fileId: string;
  name: string;
  relativePath: string;
  size: number;
  hash: string;
  alreadyExisted: boolean;
}

interface QueueItem {
  transfer: Transfer;
  attempts: number;
  notBefore: number;
  /** Já organizado na pasta; falta só o ack (não baixa de novo). */
  placed?: PlaceResult & { hash: string };
  /** Downloads completos com SHA-256 diferente. Na 2ª vez o PC chama `fail`. */
  hashFailures: number;
}

/** Quantos downloads completos com hash errado antes de desistir e chamar `fail` (o celular reenvia). */
export const RELAY_HASH_FAILURES_BEFORE_FAIL = 2;

class RelayError extends Error {
  /**
   * `reportFail` só é verdadeiro para falhas definitivas do conteúdo (contrato §4 Relay):
   * o `fail` faz a API apagar o spool e marcar `failed`, e o celular reenvia o arquivo.
   * Por isso `reportFail` implica `retry = false`.
   */
  constructor(
    message: string,
    readonly retry: boolean,
    readonly reportFail = false,
  ) {
    super(message);
  }
}

/**
 * Fila serial do relay: baixa do spool com retomada (Range) para `.part`, confere o SHA-256,
 * organiza em AAAA/MM e confirma com `ack`.
 *
 * Regra de falha (contrato §4 Relay):
 * - falha transitória (rede, 5xx/429, pouco espaço, disco) → NÃO chama `fail`; tenta de novo com backoff
 *   (o conteúdo continua no spool; ao reconectar, `GET /relay/pending` devolve o item);
 * - SHA-256 errado duas vezes seguidas, ou transferência sem metadados → chama `fail` UMA vez e desiste
 *   (a API apaga o spool, marca `failed` e o celular reenvia o arquivo);
 * - 404/410/409/401/403 da API → desiste sem `fail` (a transferência já foi encerrada do lado da API).
 *
 * Eventos: `progress`, `verifying` (RelayProgressEvent), `completed` (RelayCompletedEvent),
 * `failed` ({ transferId, fileId, name, reason, willRetry }), `queue` (número de itens).
 */
export class RelayWorker extends EventEmitter {
  private readonly queue = new Map<string, QueueItem>();
  private running = false;
  private busy = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private readonly log: Logger;
  private readonly now: Clock;
  private readonly o: Required<Pick<RelayWorkerOptions, 'minFreeMarginBytes' | 'retryBaseMs' | 'retryMaxMs' | 'maxAttempts'>>;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly opts: RelayWorkerOptions) {
    super();
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.o = {
      minFreeMarginBytes: opts.minFreeMarginBytes ?? ONE_GIB,
      retryBaseMs: opts.retryBaseMs ?? 5_000,
      retryMaxMs: opts.retryMaxMs ?? 5 * 60_000,
      maxAttempts: opts.maxAttempts ?? 8,
    };
  }

  get size(): number {
    return this.queue.size;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pump();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  /** Esvazia a fila (ex.: ao sair da conta). */
  clear(): void {
    this.queue.clear();
    this.emit('queue', 0);
  }

  enqueue(transfer: Transfer): void {
    if (!transfer?.id || transfer.status === 'done' || transfer.status === 'expired') return;
    if (this.queue.has(transfer.id)) return;
    this.queue.set(transfer.id, { transfer, attempts: 0, notBefore: 0, hashFailures: 0 });
    this.emit('queue', this.queue.size);
    this.pump();
  }

  /** `GET /v1/relay/pending` — chamado ao conectar. */
  async syncPending(): Promise<number> {
    const list = await this.opts.api.relayPending();
    for (const t of list) this.enqueue(t);
    return list.length;
  }

  /** Resolve quando a fila esvazia (ou só sobram itens em espera de backoff). Útil em testes. */
  whenIdle(): Promise<void> {
    if (!this.busy && !this.hasReadyItem()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  // ------------------------------------------------------------------

  private hasReadyItem(): boolean {
    const t = this.now();
    for (const it of this.queue.values()) if (it.notBefore <= t) return true;
    return false;
  }

  private pump(): void {
    if (!this.running || this.busy) return;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const t = this.now();
    let next: QueueItem | undefined;
    let earliest = Infinity;
    for (const it of this.queue.values()) {
      if (it.notBefore <= t) {
        next = it;
        break;
      }
      earliest = Math.min(earliest, it.notBefore);
    }
    if (!next) {
      if (earliest !== Infinity) this.wakeTimer = setTimeout(() => this.pump(), Math.max(10, earliest - t));
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
      return;
    }
    this.busy = true;
    const item = next;
    this.process(item)
      .then(() => {
        this.queue.delete(item.transfer.id);
      })
      .catch((err) => this.onError(item, err))
      .finally(() => {
        this.busy = false;
        this.abort = null;
        this.emit('queue', this.queue.size);
        this.pump();
      });
  }

  private async onError(item: QueueItem, err: unknown): Promise<void> {
    const t = item.transfer;
    const name = t.file?.name ?? t.fileId;
    let retry = true;
    let reportFail = false;
    let reason = err instanceof Error ? err.message : String(err);
    if (err instanceof RelayError) {
      reportFail = err.reportFail;
      retry = err.retry && !err.reportFail;
    } else if (err instanceof ApiError) {
      if (err.retryable) {
        // Sem rede, limite de taxa ou erro do servidor: só tenta de novo.
      } else if (err.status === 404 || err.status === 410) {
        retry = false;
        reason = 'A transferência não existe mais no servidor';
      } else {
        // 401/403 (PC removido), 409 (transferência encerrada) e outros 4xx: não adianta repetir.
        retry = false;
      }
    }
    if (!this.running) {
      // Parado no meio (saiu da conta/fechou): mantém na fila sem contar tentativa.
      return;
    }
    item.attempts++;
    const willRetry = retry && item.attempts < this.o.maxAttempts;
    this.log.warn(`Relay ${t.id}: ${reason}${willRetry ? ' (vai tentar de novo)' : ''}`);
    if (reportFail) {
      await this.opts.api.relayFail(t.id, reason).catch(() => undefined);
    }
    this.emit('failed', { transferId: t.id, fileId: t.fileId, name, reason, willRetry });
    if (willRetry) {
      const delay = Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** (item.attempts - 1));
      item.notBefore = this.now() + delay;
    } else {
      this.queue.delete(t.id);
    }
  }

  private async process(item: QueueItem): Promise<void> {
    const t = item.transfer;
    const file = t.file;
    if (!file?.hash || !file.name) throw new RelayError('Transferência sem metadados do arquivo', false, true);
    const size = Number(file.size ?? t.size);
    const key = `relay-${t.id}`;
    const ev = { transferId: t.id, fileId: t.fileId, name: file.name, takenAt: file.takenAt ?? null, total: size };

    if (!item.placed) {
      await this.opts.storage.ensurePartsDir();
      const partPath = this.opts.storage.partPath(key);
      let have = await this.opts.storage.partSize(key);
      if (have > size) {
        await fsp.truncate(partPath, 0);
        have = 0;
      }

      // Arquivo vazio: `have === size` mesmo sem `.part`; ainda precisa baixar (e criar) uma vez.
      const partMissing = have === 0 && !(await fsp.stat(partPath).then(
        () => true,
        () => false,
      ));
      if (have < size || partMissing) {
        const free =await (this.opts.freeBytes ?? (() => this.opts.storage.freeBytes()))();
        if (free < size - have + this.o.minFreeMarginBytes) {
          throw new RelayError('Pouco espaço livre no PC para receber este arquivo', true, false);
        }
        this.abort = new AbortController();
        const res = await this.opts.api.relayDownload(t.id, have, this.abort.signal);
        let writeFrom = have;
        if (res.status === 206) {
          const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
          if (!cr || Number(cr[1]) !== have) {
            await res.body?.cancel().catch(() => undefined);
            await fsp.truncate(partPath, 0).catch(() => undefined);
            throw new RelayError('Resposta parcial inesperada do servidor', true, false);
          }
        } else if (res.status === 416) {
          await res.body?.cancel().catch(() => undefined);
          await fsp.rm(partPath, { force: true });
          throw new RelayError('Retomada recusada pelo servidor; recomeçando', true, false);
        } else {
          // 200: o servidor ignorou o Range (ou não havia offset) → recomeça do zero.
          writeFrom = 0;
        }
        if (!res.body) throw new RelayError('Download sem conteúdo', true, false);

        this.emit('progress', { ...ev, received: writeFrom });
        let received = writeFrom;
        let lastEmit = 0;
        const counter = new Transform({
          transform: (chunk: Buffer, _e, cb) => {
            received += chunk.length;
            if (received > size) return cb(new RelayError('Servidor enviou mais bytes que o tamanho do arquivo', true, false));
            const now = this.now();
            if (now - lastEmit > 200) {
              lastEmit = now;
              this.emit('progress', { ...ev, received });
            }
            cb(null, chunk);
          },
        });
        try {
          // Só resolve depois de escrever tudo → fh.sync() → close.
          await this.opts.storage.writePart(
            key,
            [Readable.fromWeb(res.body), counter],
            writeFrom === 0 ? { flags: 'w' } : { flags: 'r+', start: writeFrom },
          );
        } catch (err) {
          if (err instanceof RelayError) throw err;
          if (err instanceof DiskError) throw await this.diskFailure(t.id, partPath, err);
          throw new RelayError(`Download interrompido em ${received} de ${size} bytes`, true, false);
        }
        this.emit('progress', { ...ev, received });
        if (received !== size) throw new RelayError(`Download incompleto (${received} de ${size} bytes)`, true, false);
      } else {
        // `.part` completo de uma tentativa ou execução anterior: garante que está no disco antes de conferir.
        try {
          await this.opts.storage.syncPart(key);
        } catch (err) {
          if (err instanceof DiskError) throw await this.diskFailure(t.id, partPath, err);
          throw err;
        }
      }

      // Arquivo já com fsync e fechado: confere o SHA-256 relendo o que foi gravado.
      this.emit('verifying', { ...ev, received: size });
      const actual = await this.opts.storage.hashFile(partPath);
      if (actual !== file.hash.toLowerCase()) {
        await fsp.rm(partPath, { force: true });
        item.hashFailures++;
        // 1ª vez: pode ter sido o download; baixa de novo do zero. 2ª vez: o spool está ruim → `fail`.
        const definitive = item.hashFailures >= RELAY_HASH_FAILURES_BEFORE_FAIL;
        throw new RelayError('O SHA-256 do arquivo baixado não confere', !definitive, definitive);
      }
      // rename atômico + fsync dos diretórios. Só depois disso o ack (que faz a API apagar o spool).
      const placed = await this.opts.storage.placeVerified({ partPath, name: file.name, takenAt: file.takenAt, hash: actual });
      item.placed = { ...placed, hash: actual };
    }

    const placed = item.placed;
    try {
      await this.opts.api.relayAck(t.id, { relativePath: placed.relativePath, verifiedHash: placed.hash });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        item.placed = undefined;
        throw new RelayError('O servidor recusou a verificação (hash diferente do registrado)', false, false);
      }
      throw err;
    }
    this.emit('completed', {
      transferId: t.id,
      fileId: t.fileId,
      name: file.name,
      relativePath: placed.relativePath,
      size,
      hash: placed.hash,
      alreadyExisted: placed.alreadyExisted,
    } satisfies RelayCompletedEvent);
  }

  /**
   * Erro do disco ao gravar o `.part`. É falha transitória do PC (contrato §4 Relay): sem ack e sem
   * `fail`; o conteúdo continua no spool e o PC tenta de novo com backoff.
   * - `open`/`write` (ex.: ENOSPC no meio): o `.part` fica com o que já foi gravado e a próxima
   *   tentativa retoma com `Range` (e só baixa se houver espaço livre);
   * - `sync`/`close`: depois de um fsync que falhou o conteúdo não é confiável → apaga o `.part` e a
   *   próxima tentativa baixa do zero.
   */
  private async diskFailure(transferId: string, partPath: string, err: DiskError): Promise<RelayError> {
    const untrusted = err.phase === 'sync' || err.phase === 'close';
    if (untrusted) await fsp.rm(partPath, { force: true }).catch(() => undefined);
    this.log.warn(`Relay ${transferId}: ${err.message}${untrusted ? '; .part apagado' : ''}`);
    const reason = isNoSpace(err) ? 'Disco do PC cheio ao gravar o arquivo' : `Erro ao gravar no disco do PC (${err.code ?? err.phase})`;
    return new RelayError(reason, true, false);
  }
}
