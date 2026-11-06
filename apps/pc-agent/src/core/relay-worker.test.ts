process.env.TZ = 'America/Sao_Paulo';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Transfer } from '@arkivo/shared';
import { ApiClient } from './api-client';
import { RelayCompletedEvent, RelayWorker } from './relay-worker';
import { PARTS_DIR_NAME, Storage } from './storage';
import { assertOrder, errno, fileRecord, isMark, isOp, json, sha256, spyFs, startFakeApi, tempDir, transfer, waitFor } from './test-helpers';

interface FakeState {
  pending: Transfer[];
  content: Map<string, Buffer>;
  /** Corta a conexão depois de N bytes na próxima resposta (simula queda). */
  dropAfter: Map<string, number>;
  /** Força conteúdo corrompido para um transferId. */
  corrupt: Set<string>;
  ranges: string[];
  acks: { id: string; body: unknown }[];
  fails: { id: string; reason: string }[];
  auth: string[];
  /** Chamado quando a API falsa recebe um ack (para marcar a ordem nos testes de durabilidade). */
  onAck?: () => void;
}

async function setup() {
  const st: FakeState = { pending: [], content: new Map(), dropAfter: new Map(), corrupt: new Set(), ranges: [], acks: [], fails: [], auth: [] };
  const api = await startFakeApi((req, res, body) => {
    st.auth.push(String(req.headers.authorization));
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1/relay/pending') return json(res, 200, st.pending);
    let m = /^\/v1\/relay\/([^/]+)\/download$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const id = m[1];
      let data = st.content.get(id);
      if (!data) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'não existe' } });
      if (st.corrupt.has(id)) data = Buffer.from(data.map((b) => b ^ 1));
      const range = req.headers.range;
      st.ranges.push(range ?? '');
      let start = 0;
      if (range) {
        const r = /^bytes=(\d+)-$/.exec(range)!;
        start = Number(r[1]);
        if (start >= data.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end();
          return;
        }
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`, 'Content-Length': String(data.length - start) });
      } else {
        res.writeHead(200, { 'Content-Length': String(data.length) });
      }
      const slice = data.subarray(start);
      const drop = st.dropAfter.get(id);
      if (drop !== undefined) {
        st.dropAfter.delete(id);
        res.write(slice.subarray(0, drop), () => setTimeout(() => res.socket?.destroy(), 20));
        return;
      }
      res.end(slice);
      return;
    }
    m = /^\/v1\/relay\/([^/]+)\/(ack|fail)$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const parsed = JSON.parse(body.toString() || '{}');
      if (m[2] === 'ack') {
        st.onAck?.();
        st.acks.push({ id: m[1], body: parsed });
      }
      else st.fails.push({ id: m[1], reason: parsed.reason });
      return json(res, 204);
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: req.url } });
  });
  const { dir: root, cleanup } = await tempDir();
  const client = new ApiClient({ baseUrl: api.url, getDeviceToken: () => 'tok123' });
  const storage = new Storage(() => root);
  const worker = new RelayWorker({ api: client, storage, minFreeMarginBytes: 0, retryBaseMs: 20, retryMaxMs: 100, maxAttempts: 3 });
  const completed: RelayCompletedEvent[] = [];
  const failed: { reason: string; willRetry: boolean }[] = [];
  worker.on('completed', (e: RelayCompletedEvent) => completed.push(e));
  worker.on('failed', (e: { reason: string; willRetry: boolean }) => failed.push(e));
  return {
    st,
    root,
    storage,
    worker,
    completed,
    failed,
    addTransfer(id: string, content: Buffer, name = 'IMG_20261103.jpg', takenAt = '2026-11-03T12:00:00Z') {
      const f = fileRecord({ id: `file-${id}`, hash: sha256(content), size: content.length, name, takenAt });
      const t = transfer(id, f);
      st.content.set(id, content);
      st.pending.push(t);
      return t;
    },
    async close() {
      worker.stop();
      await api.close();
      await cleanup();
    },
  };
}

describe('relay-worker', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(() => ctx.close());

  it('consome /relay/pending ao conectar, baixa, confere, organiza e faz ack', async () => {
    const a = randomBytes(40_000);
    const b = randomBytes(1234);
    ctx.addTransfer('t1', a, 'IMG_A.jpg', '2026-10-27T12:00:00Z');
    ctx.addTransfer('t2', b, 'Contrato_aluguel.pdf', '2026-11-01T12:00:00Z');
    ctx.worker.start();
    assert.equal(await ctx.worker.syncPending(), 2);
    await waitFor(() => ctx.st.acks.length === 2, 3000, 'acks');
    assert.deepEqual(ctx.st.acks, [
      { id: 't1', body: { relativePath: '2026/10/IMG_A.jpg', verifiedHash: sha256(a) } },
      { id: 't2', body: { relativePath: '2026/11/Contrato_aluguel.pdf', verifiedHash: sha256(b) } },
    ]);
    assert.ok((await fsp.readFile(path.join(ctx.root, '2026', '10', 'IMG_A.jpg'))).equals(a));
    assert.ok(ctx.st.auth.every((h) => h === 'Device tok123'));
    assert.equal(ctx.worker.size, 0);
  });

  it('transfer.ready duplicado (WS + pending) é baixado uma vez só', async () => {
    const t = ctx.addTransfer('t1', randomBytes(5000));
    ctx.worker.start();
    ctx.worker.enqueue(t);
    await ctx.worker.syncPending();
    ctx.worker.enqueue(t);
    await waitFor(() => ctx.st.acks.length === 1);
    await ctx.worker.whenIdle();
    assert.equal(ctx.st.acks.length, 1);
    assert.equal(ctx.st.ranges.length, 1);
  });

  it('queda no meio do download → retoma com Range a partir do .part', async () => {
    const content = randomBytes(200_000);
    const t = ctx.addTransfer('t9', content, 'VID_20261101.mp4');
    ctx.st.dropAfter.set('t9', 70_000);
    ctx.worker.start();
    ctx.worker.enqueue(t);
    await waitFor(() => ctx.st.acks.length === 1, 5000, 'ack após retomada');
    assert.equal(ctx.st.ranges[0], '');
    assert.match(ctx.st.ranges[1], /^bytes=\d+-$/);
    const resumedFrom = Number(/^bytes=(\d+)-$/.exec(ctx.st.ranges[1])![1]);
    assert.ok(resumedFrom > 0 && resumedFrom <= 70_000, `retomou de ${resumedFrom}`);
    assert.ok((await fsp.readFile(path.join(ctx.root, '2026', '11', 'VID_20261101.mp4'))).equals(content));
    assert.deepEqual(ctx.st.acks[0].body, { relativePath: '2026/11/VID_20261101.mp4', verifiedHash: sha256(content) });
    assert.equal(existsSync(path.join(ctx.root, '.arkivo-parciais', 'relay-t9.part')), false);
  });

  it('retoma de um .part deixado por uma execução anterior (app reiniciado)', async () => {
    const content = randomBytes(30_000);
    const t = ctx.addTransfer('t5', content, 'doc.pdf');
    const storage = new Storage(() => ctx.root);
    await storage.ensurePartsDir();
    await fsp.writeFile(storage.partPath('relay-t5'), content.subarray(0, 12_345));
    ctx.worker.start();
    ctx.worker.enqueue(t);
    await waitFor(() => ctx.st.acks.length === 1);
    assert.deepEqual(ctx.st.ranges, ['bytes=12345-']);
    assert.ok((await fsp.readFile(path.join(ctx.root, '2026', '11', 'doc.pdf'))).equals(content));
  });

  it('hash errado: baixa de novo uma vez sem fail; na 2ª chama fail UMA vez e desiste (o celular reenvia)', async () => {
    const t = ctx.addTransfer('bad', randomBytes(4000), 'ruim.jpg');
    ctx.st.corrupt.add('bad');
    ctx.worker.start();
    ctx.worker.enqueue(t);
    await waitFor(() => ctx.failed.length === 2, 5000, '2 falhas');
    await ctx.worker.whenIdle();
    assert.deepEqual(
      ctx.failed.map((f) => f.willRetry),
      [true, false],
    );
    assert.equal(ctx.st.fails.length, 1);
    assert.match(ctx.st.fails[0].reason, /SHA-256/);
    assert.deepEqual(ctx.st.ranges, ['', ''], 'o segundo download recomeça do zero');
    assert.equal(ctx.st.acks.length, 0);
    assert.equal(existsSync(path.join(ctx.root, '2026', '11', 'ruim.jpg')), false);
    assert.equal(ctx.worker.size, 0);
  });

  it('hash errado uma vez e depois certo → salva no segundo intento', async () => {
    const content = randomBytes(4000);
    const t = ctx.addTransfer('flaky', content, 'ok.jpg');
    ctx.st.corrupt.add('flaky');
    ctx.worker.once('failed', () => ctx.st.corrupt.delete('flaky'));
    ctx.worker.start();
    ctx.worker.enqueue(t);
    await waitFor(() => ctx.st.acks.length === 1, 3000);
    assert.equal(ctx.st.fails.length, 0, 'falha que se resolve sozinha não chama fail');
    assert.ok((await fsp.readFile(path.join(ctx.root, '2026', '11', 'ok.jpg'))).equals(content));
  });

  it('transferência que sumiu do servidor (404) é descartada sem fail', async () => {
    const t = ctx.addTransfer('gone', randomBytes(100));
    ctx.st.content.delete('gone');
    ctx.worker.start();
    ctx.worker.enqueue(t);
    await waitFor(() => ctx.failed.length === 1);
    assert.equal(ctx.failed[0].willRetry, false);
    assert.equal(ctx.st.fails.length, 0);
  });

  it('sem espaço livre → não baixa, NÃO chama fail (spool continua) e tenta depois', async () => {
    const t = ctx.addTransfer('big', randomBytes(1000));
    const storage = new Storage(() => ctx.root);
    const client = new ApiClient({ baseUrl: (ctx.worker as unknown as { opts: { api: ApiClient } }).opts.api.baseUrl, getDeviceToken: () => 'tok123' });
    const w = new RelayWorker({ api: client, storage, freeBytes: async () => 10, minFreeMarginBytes: 0, retryBaseMs: 10_000 });
    const fails: string[] = [];
    w.on('failed', (e: { reason: string }) => fails.push(e.reason));
    w.start();
    w.enqueue(t);
    await waitFor(() => fails.length === 1);
    assert.match(fails[0], /espaço/);
    assert.equal(ctx.st.ranges.length, 0);
    assert.equal(w.size, 1, 'continua na fila para tentar depois');
    assert.equal(ctx.st.fails.length, 0);
    w.stop();
  });

  it('erro 5xx no download → tenta de novo sem fail', async () => {
    const t = ctx.addTransfer('t500', randomBytes(3000), 'x.jpg');
    // O primeiro download responde 503; os seguintes vão para a API falsa normal.
    const storage = new Storage(() => ctx.root);
    const baseUrl = (ctx.worker as unknown as { opts: { api: ApiClient } }).opts.api.baseUrl;
    let calls = 0;
    const client = new ApiClient({
      baseUrl,
      getDeviceToken: () => 'tok123',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/download') && calls++ === 0) {
          return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'x' } }), { status: 503 });
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    const w = new RelayWorker({ api: client, storage, minFreeMarginBytes: 0, retryBaseMs: 10, retryMaxMs: 20 });
    w.start();
    w.enqueue(t);
    await waitFor(() => ctx.st.acks.length === 1, 3000, 'ack depois do 503');
    assert.equal(ctx.st.fails.length, 0);
    w.stop();
  });

  describe('durabilidade antes do ack', () => {
    function markHash(spy: Awaited<ReturnType<typeof spyFs>>) {
      const real = ctx.storage.hashFile.bind(ctx.storage);
      return mock.method(ctx.storage, 'hashFile', (file: string) => {
        spy.mark('hash', path.resolve(file));
        return real(file);
      });
    }

    it('ordem: download → fh.sync → close → SHA-256 → rename → fsync dos diretórios → ack', async () => {
      const content = randomBytes(120_000);
      const t = ctx.addTransfer('ord', content, 'VID_ordem.mp4', '2026-11-02T12:00:00Z');
      const part = ctx.storage.partPath('relay-ord');
      const destDir = path.join(ctx.root, '2026', '11');
      const spy = await spyFs();
      const h = markHash(spy);
      ctx.st.onAck = () => spy.mark('ack');
      try {
        ctx.worker.start();
        ctx.worker.enqueue(t);
        await waitFor(() => ctx.st.acks.length === 1, 3000, 'ack');
      } finally {
        h.mock.restore();
        spy.restore();
      }
      const [, iSync] = assertOrder(spy.events, [
        ['escrita no .part', isOp('write', part)],
        ['fh.sync do .part', isOp('sync', part)],
        ['close do .part', isOp('close', part)],
        ['SHA-256', (e) => isMark('hash')(e) && e.extra === path.resolve(part)],
        ['rename .part → destino', (e) => e.op === 'rename' && e.path === path.resolve(part) && e.extra === path.resolve(destDir, 'VID_ordem.mp4')],
        ['fsync do diretório de destino', isOp('sync', destDir)],
        ['fsync da pasta de parciais', isOp('sync', path.join(ctx.root, PARTS_DIR_NAME))],
        ['ack', isMark('ack')],
      ]);
      assert.ok(!spy.events.slice(iSync).some(isOp('write', part)), 'nada é escrito no .part depois do fsync');
    });

    it('fh.sync falha → sem ack e sem fail; .part apagado e a nova tentativa baixa do zero', async () => {
      const content = randomBytes(40_000);
      const t = ctx.addTransfer('sfail', content, 'sync.jpg');
      const part = ctx.storage.partPath('relay-sfail');
      let failedOnce = false;
      const spy = await spyFs((op, p) => {
        if (op !== 'sync' || p !== path.resolve(part) || failedOnce) return undefined;
        failedOnce = true;
        return errno('EIO', 'fsync');
      });
      const acksAtFailure: number[] = [];
      ctx.worker.on('failed', () => acksAtFailure.push(ctx.st.acks.length));
      try {
        ctx.worker.start();
        ctx.worker.enqueue(t);
        await waitFor(() => ctx.st.acks.length === 1, 5000, 'ack depois da nova tentativa');
      } finally {
        spy.restore();
      }
      assert.deepEqual(acksAtFailure, [0], 'nenhum ack antes da falha');
      assert.deepEqual(
        ctx.failed.map((f) => f.willRetry),
        [true],
      );
      assert.match(ctx.failed[0].reason, /disco/i);
      assert.equal(ctx.st.fails.length, 0, 'erro de disco é transitório: não chama fail (§4 Relay)');
      assert.deepEqual(ctx.st.ranges, ['', ''], 'a segunda tentativa recomeça do zero');
      assert.ok((await fsp.readFile(path.join(ctx.root, '2026', '11', 'sync.jpg'))).equals(content));
    });

    it('ENOSPC no meio do download → sem ack e sem fail; o .part fica e a retomada usa Range', async () => {
      const content = randomBytes(600_000);
      const t = ctx.addTransfer('full', content, 'cheio.mp4');
      const part = ctx.storage.partPath('relay-full');
      let writes = 0;
      const spy = await spyFs((op, p) => (op === 'write' && p === path.resolve(part) && ++writes === 2 ? errno('ENOSPC') : undefined));
      try {
        ctx.worker.start();
        ctx.worker.enqueue(t);
        await waitFor(() => ctx.st.acks.length === 1, 5000, 'ack depois da retomada');
      } finally {
        spy.restore();
      }
      assert.equal(ctx.failed.length, 1);
      assert.equal(ctx.failed[0].willRetry, true);
      assert.match(ctx.failed[0].reason, /cheio/);
      assert.equal(ctx.st.fails.length, 0);
      assert.equal(ctx.st.ranges[0], '');
      const resumedFrom = Number(/^bytes=(\d+)-$/.exec(ctx.st.ranges[1] ?? '')?.[1]);
      assert.ok(resumedFrom > 0 && resumedFrom < content.length, `retomou de ${ctx.st.ranges[1]}`);
      assert.ok((await fsp.readFile(path.join(ctx.root, '2026', '11', 'cheio.mp4'))).equals(content));
    });

    it('.part completo de uma execução anterior passa por fsync antes de conferir', async () => {
      const content = randomBytes(10_000);
      const t = ctx.addTransfer('prev', content, 'prev.jpg');
      await ctx.storage.ensurePartsDir();
      const part = ctx.storage.partPath('relay-prev');
      await fsp.writeFile(part, content);
      const spy = await spyFs();
      const h = markHash(spy);
      try {
        ctx.worker.start();
        ctx.worker.enqueue(t);
        await waitFor(() => ctx.st.acks.length === 1);
      } finally {
        h.mock.restore();
        spy.restore();
      }
      assert.deepEqual(ctx.st.ranges, [], 'não baixou de novo');
      assertOrder(spy.events, [
        ['fh.sync do .part', isOp('sync', part)],
        ['SHA-256', (e) => isMark('hash')(e) && e.extra === path.resolve(part)],
        ['rename', (e) => e.op === 'rename' && e.path === path.resolve(part)],
      ]);
    });
  });
});
