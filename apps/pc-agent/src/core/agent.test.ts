process.env.TZ = 'America/Sao_Paulo';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { deriveFsE2eKeys, openFsEnvelope, sealFsEnvelope, type FsRpcResult, type WsMessage } from '@arkivo/shared';
import { Agent, NOTES } from './agent';
import { assertOrder, fakeWsFactory, fileRecord, fsTempDir, isOp, json, newPairKey, sha256, signedHeaders, spyFs, startFakeApi, tempDir, transfer, waitFor } from './test-helpers';
import { plainCipher } from './types';

describe('agente (integração com API falsa, WS falso e servidor LAN real)', () => {
  const pairKey = newPairKey();
  const relayContent = randomBytes(20_000);
  const relayFile = fileRecord({ id: 'fr1', hash: sha256(relayContent), size: relayContent.length, name: 'VID_20261101.mp4', takenAt: '2026-11-01T15:00:00Z' });
  const calls: { method: string; path: string; auth?: string; body?: unknown }[] = [];
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let agent: Agent;
  const ws = fakeWsFactory();

  before(async () => {
    tmp = await tempDir();
    api = await startFakeApi((req, res, body) => {
      const url = new URL(req.url!, 'http://x');
      calls.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization, body: body.length ? JSON.parse(body.toString()) : undefined });
      const p = url.pathname;
      if (p === '/v1/pairings' && req.method === 'POST')
        return json(res, 201, { pairingId: 'pp1', code: 'ABCD2345', pollToken: 'pt', expiresAt: new Date(Date.now() + 300_000).toISOString(), qrPayload: 'arkivo://pair?id=pp1&code=ABCD2345&v=1' });
      if (p === '/v1/devices/pc/peers') return json(res, 200, { phones: [{ id: 'phone1', name: 'Galaxy do Thiago' }] });
      if (p === '/v1/devices/pc/self') return json(res, 200, { id: 'pc1' });
      if (p === '/v1/devices/pc/logout') return json(res, 204);
      if (p === '/v1/relay/pending') return json(res, 200, []);
      if (p === '/v1/files/fl-offline/locations') return json(res, 503, { error: { code: 'INTERNAL', message: 'fora do ar' } });
      if (/^\/v1\/files\/[^/]+\/locations$/.test(p)) return json(res, 200, { id: 'x' });
      if (p === '/v1/relay/tr1/download') {
        res.writeHead(200, { 'Content-Length': String(relayContent.length) }).end(relayContent);
        return;
      }
      if (/^\/v1\/relay\/[^/]+\/ack$/.test(p)) return json(res, 204);
      json(res, 404, { error: { code: 'NOT_FOUND', message: p } });
    });
    agent = new Agent({
      dataDir: path.join(tmp.dir, 'userData'),
      cipher: plainCipher,
      wsFactory: ws.factory,
      qr: async (t) => `data:qr,${t}`,
      appVersion: '0.1.0',
      platform: 'windows',
      pcName: 'PC-THIAGO',
      apiBaseUrl: api.url,
      suggestedStorageDir: path.join(tmp.dir, 'Imagens', 'Arkivo'),
      lanHost: '127.0.0.1',
      lanPort: 0,
      minFreeMarginBytes: 0,
      logger: { info() {}, warn() {}, error() {} },
    });
  });
  after(async () => {
    await agent.shutdown();
    await api.close();
    await tmp.cleanup();
  });

  it('começa no passo 1 com a pasta sugerida', async () => {
    await agent.init();
    assert.equal(agent.state.phase, 'folder');
    assert.equal(agent.state.storageDir, path.join(tmp.dir, 'Imagens', 'Arkivo'));
    assert.equal(agent.state.autostart, true);
  });

  it('Continuar cria a pasta e mostra o QR; pairing.claimed leva à tela ativa', async () => {
    await agent.continueToPairing();
    assert.ok(existsSync(path.join(tmp.dir, 'Imagens', 'Arkivo')));
    await waitFor(() => agent.state.pairing?.status === 'waiting');
    assert.equal(agent.state.phase, 'pairing');
    assert.equal(agent.state.pairing?.qrDataUrl, 'data:qr,arkivo://pair?id=pp1&code=ABCD2345&v=1');
    // Link copiável abaixo do QR (para quem não consegue escanear).
    assert.equal(agent.state.pairing?.link, 'arkivo://pair?id=pp1&code=ABCD2345&v=1');
    const anon = ws.sockets[0];
    assert.match(anon.url, /pairing=pp1/);
    anon.simulateOpen();
    anon.simulateMessage({ type: 'pairing.claimed', data: { deviceId: 'pc1', deviceToken: 'devtok', pairKey, user: { name: 'Thiago', handle: 'thiago', email: 'thiago@gmail.com' } } });
    await waitFor(() => agent.state.phase === 'active' && agent.state.lan.listening);
    assert.deepEqual(agent.state.account, { name: 'Thiago', handle: 'thiago', email: 'thiago@gmail.com' });
    const dev = ws.sockets[1];
    assert.match(dev.url, /device=devtok/);
    dev.simulateOpen();
    await waitFor(() => agent.state.phones.length === 1 && agent.state.serverConnected);
    await waitFor(() => calls.some((c) => c.path === '/v1/devices/pc/self' && c.method === 'PATCH'));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    assert.equal(patch.auth, 'Device devtok');
    assert.equal((patch.body as { lanPort: number }).lanPort, agent.state.lan.port);
    const status = JSON.parse(dev.sent[0]);
    assert.equal(status.type, 'pc.status');
    assert.equal(status.data.lanPort, agent.state.lan.port);
    // §10.9, §11: a build anuncia "fs" e "fs-push" no PATCH, no pc.status e no ping.
    assert.deepEqual((patch.body as { capabilities?: string[] }).capabilities, ['fs', 'fs-push']);
    assert.deepEqual(status.data.capabilities, ['fs', 'fs-push']);
    const ping = (await (await fetch(`http://127.0.0.1:${agent.state.lan.port}/v1/ping`)).json()) as { capabilities?: string[] };
    assert.deepEqual(ping.capabilities, ['fs', 'fs-push']);
  });

  it('fs.request pelo WebSocket volta como fs.response cifrado (interruptor desligado → FS_DISABLED)', async () => {
    const keys = await deriveFsE2eKeys(pairKey, 'pc1');
    const env = await sealFsEnvelope(keys, { phone: 'phone1', typ: 'req' }, { op: 'roots' });
    const dev = ws.sockets[1];
    const before = dev.sent.length;
    dev.simulateMessage({ type: 'fs.request', data: { rpcId: 'rpc-1', phoneDeviceId: 'phone1', envelope: env } });
    const find = () => dev.sent.slice(before).map((s) => JSON.parse(s) as WsMessage).find((m) => m.type === 'fs.response');
    await waitFor(() => !!find());
    const msg = find()!;
    assert.ok(msg.type === 'fs.response' && msg.data.rpcId === 'rpc-1' && msg.data.envelope);
    const opened = await openFsEnvelope<FsRpcResult>(keys, msg.data.envelope, { typ: 'res', phone: 'phone1', rid: env.rid });
    assert.equal(!opened.payload.ok && opened.payload.error.code, 'FS_DISABLED');
    assert.deepEqual(agent.state.fs, { enabled: false, roots: [], drives: [], audit: [] });
  });

  it('recebe pela LAN, reporta o local e registra na atividade', async () => {
    const body = randomBytes(10_000);
    const hash = sha256(body);
    const p = '/v1/files/fl1';
    const r = await fetch(`http://127.0.0.1:${agent.state.lan.port}${p}`, {
      method: 'PUT',
      headers: {
        ...signedHeaders({ pairKey, phoneId: 'phone1', method: 'PUT', path: p, hash }),
        'X-Arkivo-Name': encodeURIComponent('IMG_20261103_103000.jpg'),
        'X-Arkivo-Taken-At': '2026-11-03T13:00:00Z',
        'X-Arkivo-Kind': 'photo',
      },
      body,
    });
    assert.equal(r.status, 200);
    await r.json();
    await waitFor(() => agent.state.totalSaved === 1);
    const loc = calls.find((c) => c.path === '/v1/files/fl1/locations')!;
    assert.deepEqual(loc.body, { relativePath: '2026/11/IMG_20261103_103000.jpg', verifiedHash: hash });
    assert.equal(agent.state.log[0].route, 'lan');
    assert.deepEqual(agent.state.months, [{ month: '2026-11', count: 1 }]);
    assert.equal(agent.state.lastRoute, 'lan');
  });

  it('API fora: o local vai para pending-reports.json com tmp → fsync → rename → fsync do diretório', async () => {
    const body = randomBytes(5_000);
    const hash = sha256(body);
    const p = '/v1/files/fl-offline';
    const dataDir = path.join(tmp.dir, 'userData');
    const reportsFile = path.join(dataDir, 'pending-reports.json');
    const spy = await spyFs();
    try {
      const r = await fetch(`http://127.0.0.1:${agent.state.lan.port}${p}`, {
        method: 'PUT',
        headers: {
          ...signedHeaders({ pairKey, phoneId: 'phone1', method: 'PUT', path: p, hash }),
          'X-Arkivo-Name': encodeURIComponent('IMG_offline.jpg'),
          'X-Arkivo-Taken-At': '2026-11-03T13:00:00Z',
        },
        body,
      });
      assert.equal(r.status, 200);
      await r.json();
    } finally {
      spy.restore();
    }
    const rename = spy.events.find((e) => e.op === 'rename' && e.extra === path.resolve(reportsFile));
    assert.ok(rename, 'pending-reports.json gravado por rename de um temporário');
    assertOrder(spy.events, [
      ['fsync do temporário', isOp('sync', rename.path)],
      ['rename para pending-reports.json', (e) => e === rename],
      ['fsync do diretório de dados', isOp('sync', dataDir)],
    ]);
    const saved = JSON.parse(await fsp.readFile(reportsFile, 'utf8')) as { fileId: string; verifiedHash: string }[];
    assert.deepEqual(
      saved.map((s) => [s.fileId, s.verifiedHash]),
      [['fl-offline', hash]],
    );
    assert.deepEqual((await fsp.readdir(dataDir)).filter((n) => n.startsWith('pending-reports.json.') && n.endsWith('.tmp')), []);
  });

  it('transfer.ready pelo WS baixa do relay e faz ack', async () => {
    ws.sockets[1].simulateMessage({ type: 'transfer.ready', data: { transfer: transfer('tr1', relayFile) } });
    await waitFor(() => calls.some((c) => c.path === '/v1/relay/tr1/ack'));
    const ack = calls.find((c) => c.path === '/v1/relay/tr1/ack')!;
    assert.deepEqual(ack.body, { relativePath: '2026/11/VID_20261101.mp4', verifiedHash: relayFile.hash });
    // 1 (LAN) + 1 (LAN com a API fora) + 1 (relay)
    await waitFor(() => agent.state.totalSaved === 3);
    const saved = await fsp.readFile(path.join(agent.state.storageDir!, '2026', '11', 'VID_20261101.mp4'));
    assert.ok(saved.equals(relayContent));
  });

  it('device.revoked volta ao QR com aviso e apaga as credenciais', async () => {
    const shared = await fsTempDir('agente-');
    try {
      await agent.fsAddRoot(shared.dir);
      assert.equal(agent.fs.roots.enabled, true);
      ws.sockets[1].simulateMessage({ type: 'device.revoked', data: {} });
      await waitFor(() => agent.state.phase === 'pairing');
      assert.equal(agent.state.note, NOTES.revoked);
      assert.equal(agent.config.getCredentials(), null);
      assert.equal(agent.state.lan.listening, false);
      // a pasta e o histórico continuam
      assert.equal(agent.state.totalSaved, 3);
      // Pastas liberadas: a lista fica, mas o acesso desliga (o próximo pareamento pode ser de outra conta).
      await waitFor(() => agent.fs.roots.enabled === false);
      assert.equal(agent.fs.roots.roots.length, 1);
      assert.equal(agent.config.settings.fsEnabled, false);
    } finally {
      await agent.fsRemoveRoot(agent.fs.roots.roots[0]?.id ?? '');
      await shared.cleanup();
    }
  });

  it('Sair da conta chama /devices/pc/logout e mostra o aviso do protótipo', async () => {
    await waitFor(() => agent.state.pairing?.status === 'waiting');
    const anon = ws.sockets[ws.sockets.length - 1];
    anon.simulateOpen();
    anon.simulateMessage({ type: 'pairing.claimed', data: { deviceId: 'pc1', deviceToken: 'devtok2', pairKey, user: { name: 'Thiago', handle: 'thiago', email: 'thiago@gmail.com' } } });
    await waitFor(() => agent.state.phase === 'active');
    await agent.logout();
    assert.ok(calls.some((c) => c.path === '/v1/devices/pc/logout' && c.auth === 'Device devtok2'));
    assert.equal(agent.state.phase, 'pairing');
    assert.equal(agent.state.note, NOTES.loggedOut);
  });
});
