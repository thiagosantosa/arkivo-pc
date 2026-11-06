// Versão recusada pela API (contrato §9): o agente entra em `updateRequired` e para de tentar.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION, WS_CLOSE, formatUpgradeCloseReason, upgradeRequiredBody } from '@arkivo/shared';
import { Agent } from './agent';
import { fakeWsFactory, json, newPairKey, sleep, startFakeApi, tempDir, waitFor } from './test-helpers';
import { plainCipher } from './types';

describe('agente: atualização obrigatória (HTTP 426 / WS 4426)', () => {
  const calls: { method: string; path: string; client?: string; protocol?: string }[] = [];
  let outdated = false;
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  let tmp: { dir: string; cleanup: () => Promise<void> };
  const agents: Agent[] = [];

  before(async () => {
    tmp = await tempDir();
    api = await startFakeApi((req, res) => {
      const p = new URL(req.url!, 'http://x').pathname;
      calls.push({ method: req.method!, path: p, client: req.headers['x-arkivo-client'] as string, protocol: req.headers['x-arkivo-protocol'] as string });
      if (outdated) return json(res, 426, upgradeRequiredBody({ minVersion: '0.2.0', kind: 'pc', protocol: PROTOCOL_VERSION }));
      if (p === '/v1/pairings' && req.method === 'POST')
        return json(res, 201, { pairingId: 'pp1', code: 'ABCD2345', pollToken: 'pt', expiresAt: new Date(Date.now() + 300_000).toISOString(), qrPayload: 'arkivo://pair?id=pp1&code=ABCD2345&v=1' });
      if (p === '/v1/devices/pc/peers') return json(res, 200, { phones: [] });
      if (p === '/v1/devices/pc/self') return json(res, 200, { id: 'pc1' });
      if (p === '/v1/relay/pending') return json(res, 200, []);
      json(res, 404, { error: { code: 'NOT_FOUND', message: p } });
    });
  });
  after(async () => {
    for (const a of agents) await a.shutdown();
    await api.close();
    await tmp.cleanup();
  });

  function newAgent(name: string, ws: ReturnType<typeof fakeWsFactory>): Agent {
    const a = new Agent({
      dataDir: path.join(tmp.dir, name),
      cipher: plainCipher,
      wsFactory: ws.factory,
      qr: async (t) => `data:qr,${t}`,
      appVersion: '0.1.0',
      platform: 'windows',
      pcName: 'PC-THIAGO',
      apiBaseUrl: api.url,
      suggestedStorageDir: path.join(tmp.dir, name, 'Arkivo'),
      lanHost: '127.0.0.1',
      lanPort: 0,
      minFreeMarginBytes: 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    agents.push(a);
    return a;
  }

  it('toda chamada à API leva X-Arkivo-Client: pc/<versão> e X-Arkivo-Protocol; o WS leva os mesmos na query', async () => {
    outdated = false;
    const ws = fakeWsFactory();
    const agent = newAgent('a1', ws);
    await agent.init();
    await agent.continueToPairing();
    await waitFor(() => agent.state.pairing?.status === 'waiting');
    const create = calls.find((c) => c.path === '/v1/pairings')!;
    assert.equal(create.client, 'pc/0.1.0');
    assert.equal(create.protocol, String(PROTOCOL_VERSION));
    const u = new URL(ws.sockets[0].url);
    assert.equal(u.searchParams.get('client'), 'pc/0.1.0');
    assert.equal(u.searchParams.get('protocol'), String(PROTOCOL_VERSION));
  });

  it('WS fechado com 4426 → updateRequired com a versão mínima, serviços parados, sem reconectar', async () => {
    outdated = false;
    const ws = fakeWsFactory();
    const agent = newAgent('a2', ws);
    await agent.init();
    await agent.continueToPairing();
    await waitFor(() => agent.state.pairing?.status === 'waiting');
    const anon = ws.sockets[0];
    anon.simulateOpen();
    anon.simulateMessage({ type: 'pairing.claimed', data: { deviceId: 'pc1', deviceToken: 'devtok', pairKey: newPairKey(), user: { name: 'T', handle: 't', email: 't@x.com' } } });
    await waitFor(() => agent.state.phase === 'active' && agent.state.lan.listening);
    const dev = ws.sockets[1];
    dev.simulateOpen();
    await waitFor(() => agent.state.serverConnected);

    dev.simulateDrop(WS_CLOSE.UPGRADE_REQUIRED, formatUpgradeCloseReason({ minVersion: '0.4.0', kind: 'pc', protocol: PROTOCOL_VERSION }));
    await waitFor(() => agent.state.phase === 'updateRequired' && !agent.state.lan.listening, 3000, 'updateRequired');
    assert.deepEqual(agent.state.updateRequired, { minVersion: '0.4.0', protocol: PROTOCOL_VERSION });
    assert.equal(agent.state.serverConnected, false);
    await sleep(1200);
    assert.equal(ws.sockets.length, 2, 'não abriu outro WebSocket');
    // As credenciais ficam: a versão nova retoma sem parear de novo.
    assert.ok(agent.config.getCredentials());
    // Ações da UI não tiram o agente do bloqueio.
    await agent.continueToPairing();
    assert.equal(agent.state.phase, 'updateRequired');
  });

  it('HTTP 426 no pareamento → updateRequired e o fluxo do QR para', async () => {
    outdated = true;
    const ws = fakeWsFactory();
    const agent = newAgent('a3', ws);
    await agent.init();
    const before = calls.length;
    await agent.continueToPairing();
    await waitFor(() => agent.state.phase === 'updateRequired', 3000, 'updateRequired');
    assert.deepEqual(agent.state.updateRequired, { minVersion: '0.2.0', protocol: PROTOCOL_VERSION });
    assert.equal(agent.state.pairing, null);
    await sleep(300);
    assert.equal(calls.slice(before).filter((c) => c.path === '/v1/pairings').length, 1, 'não insiste no pareamento');
    assert.equal(ws.sockets.length, 0);
  });
});
