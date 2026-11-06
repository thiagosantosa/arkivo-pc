import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { PairingPollResponse } from '@arkivo/shared';
import { ApiClient } from './api-client';
import { PairingFlow, PairingResult, PairingState } from './pairing';
import { fakeWsFactory, json, startFakeApi, waitFor } from './test-helpers';

async function fakeApi(opts: { poll?: () => PairingPollResponse; failCreate?: () => boolean } = {}) {
  let n = 0;
  const created: { body: unknown }[] = [];
  const polls: string[] = [];
  const api = await startFakeApi((req, res, body) => {
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/v1/pairings') {
      if (opts.failCreate?.()) return json(res, 500, { error: { code: 'INTERNAL', message: 'fora' } });
      n++;
      created.push({ body: JSON.parse(body.toString()) });
      return json(res, 201, {
        pairingId: `p${n}`,
        code: 'ABCD2345',
        pollToken: `poll${n}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        qrPayload: `arkivo://pair?id=p${n}&code=ABCD2345&v=1`,
      });
    }
    const m = /^\/v1\/pairings\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      polls.push(`${m[1]}:${url.searchParams.get('pollToken')}`);
      return json(res, 200, opts.poll?.() ?? { status: 'pending' });
    }
    json(res, 404, {});
  });
  return { api, created, polls, client: new ApiClient({ baseUrl: api.url, getDeviceToken: () => null }) };
}

const claimed = { deviceId: 'pc1', deviceToken: 'tok', pairKey: 'a2V5', user: { name: 'Thiago', handle: 'thiago', email: 'thiago@gmail.com' } };

describe('pareamento por QR', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('cria pareamento, gera QR do qrPayload e recebe pairing.claimed pelo WS anônimo', async () => {
    const f = await fakeApi();
    cleanups.push(() => f.api.close());
    const ws = fakeWsFactory();
    const qrTexts: string[] = [];
    const flow = new PairingFlow({
      api: f.client,
      qr: async (t) => {
        qrTexts.push(t);
        return 'data:image/png;base64,QR';
      },
      wsFactory: ws.factory,
      pcName: 'PC-THIAGO',
      platform: 'windows',
    });
    cleanups.push(() => flow.stop());
    const states: PairingState[] = [];
    flow.on('state', (s: PairingState) => states.push(s));
    const result = new Promise<PairingResult>((r) => flow.once('claimed', r));
    flow.start();
    await waitFor(() => flow.state.status === 'waiting');
    assert.deepEqual(f.created[0].body, { pcName: 'PC-THIAGO', platform: 'windows' });
    assert.deepEqual(qrTexts, ['arkivo://pair?id=p1&code=ABCD2345&v=1']);
    assert.equal(flow.state.qrDataUrl, 'data:image/png;base64,QR');
    assert.match(flow.state.qrPayload ?? '', /^arkivo:\/\/pair\?id=p1&code=ABCD2345&v=1$/);
    const left = flow.state.expiresAt! - Date.now();
    assert.ok(left > 295_000 && left <= 300_000, `expira em ${left} ms`);
    assert.equal(ws.sockets.length, 1);
    const u = new URL(ws.sockets[0].url);
    assert.equal(u.protocol, 'ws:');
    assert.equal(u.pathname, '/v1/ws');
    assert.equal(u.searchParams.get('pairing'), 'p1');
    assert.equal(u.searchParams.get('pollToken'), 'poll1');
    ws.sockets[0].simulateOpen();
    ws.sockets[0].simulateMessage({ type: 'pairing.claimed', data: claimed });
    assert.deepEqual(await result, claimed);
    assert.equal(ws.sockets[0].closed, true);
    assert.equal(f.polls.length, 0, 'com WS aberto não faz polling');
  });

  it('sem WS (conexão cai) faz polling a cada intervalo e conclui pelo GET', async () => {
    let calls = 0;
    const f = await fakeApi({ poll: () => (++calls < 3 ? { status: 'pending' } : { status: 'claimed', ...claimed }) });
    cleanups.push(() => f.api.close());
    const ws = fakeWsFactory();
    const flow = new PairingFlow({ api: f.client, qr: async () => 'data:,', wsFactory: ws.factory, pcName: 'PC', platform: 'linux', pollIntervalMs: 20 });
    cleanups.push(() => flow.stop());
    const result = new Promise<PairingResult>((r) => flow.once('claimed', r));
    flow.start();
    await waitFor(() => ws.sockets.length === 1);
    ws.sockets[0].simulateDrop();
    assert.deepEqual(await result, claimed);
    assert.equal(f.polls.length, 3);
    assert.equal(f.polls[0], 'p1:poll1');
  });

  it('renova o QR quando o código expira', async () => {
    const f = await fakeApi();
    cleanups.push(() => f.api.close());
    const ws = fakeWsFactory();
    const flow = new PairingFlow({ api: f.client, qr: async (t) => t, wsFactory: ws.factory, pcName: 'PC', platform: 'windows', ttlSeconds: 0.15 });
    cleanups.push(() => flow.stop());
    flow.start();
    await waitFor(() => f.created.length >= 2, 2000, 'novo pareamento');
    await waitFor(() => flow.state.qrDataUrl === 'arkivo://pair?id=p2&code=ABCD2345&v=1');
    assert.equal(ws.sockets[0].closed, true, 'fecha o WS do código antigo');
  });

  it('pairing.expired pelo WS também renova', async () => {
    const f = await fakeApi();
    cleanups.push(() => f.api.close());
    const ws = fakeWsFactory();
    const flow = new PairingFlow({ api: f.client, qr: async (t) => t, wsFactory: ws.factory, pcName: 'PC', platform: 'windows' });
    cleanups.push(() => flow.stop());
    flow.start();
    await waitFor(() => ws.sockets.length === 1);
    ws.sockets[0].simulateOpen();
    ws.sockets[0].simulateMessage({ type: 'pairing.expired', data: {} });
    await waitFor(() => f.created.length === 2);
  });

  it('servidor fora do ar → estado de erro e nova tentativa', async () => {
    let fail = true;
    const f = await fakeApi({ failCreate: () => fail });
    cleanups.push(() => f.api.close());
    const flow = new PairingFlow({ api: f.client, qr: async () => 'qr', wsFactory: fakeWsFactory().factory, pcName: 'PC', platform: 'windows', retryDelayMs: 30 });
    cleanups.push(() => flow.stop());
    flow.start();
    await waitFor(() => flow.state.status === 'error');
    assert.match(flow.state.error!, /Sem conexão/);
    fail = false;
    await waitFor(() => flow.state.status === 'waiting');
  });
});
