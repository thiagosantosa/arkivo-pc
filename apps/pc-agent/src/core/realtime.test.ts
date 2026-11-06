import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTOCOL_VERSION, WS_CLOSE, formatUpgradeCloseReason, type UpgradeRequiredInfo, type WsMessage } from '@arkivo/shared';
import { ApiClient } from './api-client';
import { isPrivateIPv4, lanIPv4Addresses } from './net-info';
import { RealtimeClient } from './realtime';
import { fakeWsFactory, waitFor } from './test-helpers';

const api = new ApiClient({ baseUrl: 'https://api.arkivo.test', getDeviceToken: () => 'dev-tok' });
const status = { lanAddresses: ['192.168.0.10'], lanPort: 47800, freeBytes: 123, receiving: false };

describe('realtime (WS do PC)', () => {
  it('conecta com ?device=, envia pc.status ao abrir e repassa mensagens', async () => {
    const ws = fakeWsFactory();
    const rt = new RealtimeClient({ api, getDeviceToken: () => 'dev-tok', wsFactory: ws.factory, getStatus: async () => status });
    const msgs: WsMessage[] = [];
    rt.on('message', (m: WsMessage) => msgs.push(m));
    rt.start();
    const u = new URL(ws.sockets[0].url);
    assert.equal(u.protocol, 'wss:');
    assert.equal(u.pathname, '/v1/ws');
    assert.equal(u.searchParams.get('device'), 'dev-tok');
    ws.sockets[0].simulateOpen();
    await waitFor(() => ws.sockets[0].sent.length === 1);
    assert.deepEqual(JSON.parse(ws.sockets[0].sent[0]), { type: 'pc.status', data: status });
    ws.sockets[0].simulateMessage({ type: 'peers.changed', data: { phones: [{ id: 'p1', name: 'Galaxy do Thiago' }] } });
    assert.equal(msgs[0].type, 'peers.changed');
    rt.stop();
  });

  it('reconecta com backoff exponencial depois de cair', async () => {
    const ws = fakeWsFactory();
    const rt = new RealtimeClient({ api, getDeviceToken: () => 't', wsFactory: ws.factory, getStatus: async () => status, minBackoffMs: 10, maxBackoffMs: 40, random: () => 1 });
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => rt.backoffDelay(n)), [10, 20, 40, 40, 40]);
    let connects = 0;
    rt.on('connected', () => connects++);
    rt.start();
    ws.sockets[0].simulateOpen();
    ws.sockets[0].simulateDrop();
    await waitFor(() => ws.sockets.length === 2, 1000, 'reconexão 1');
    ws.sockets[1].simulateDrop(); // falhou sem abrir
    await waitFor(() => ws.sockets.length === 3, 1000, 'reconexão 2');
    ws.sockets[2].simulateOpen();
    assert.equal(connects, 2);
    rt.stop();
    assert.equal(ws.sockets[2].closed, true);
  });

  it('fechamento 4401 (credencial recusada) confere beforeReconnect já na primeira reconexão', async () => {
    const ws = fakeWsFactory();
    let checks = 0;
    const rt = new RealtimeClient({
      api, getDeviceToken: () => 't', wsFactory: ws.factory, getStatus: async () => status, minBackoffMs: 5, maxBackoffMs: 5,
      beforeReconnect: async () => (checks++, false),
    });
    let stopped = false;
    rt.on('stopped', () => (stopped = true));
    rt.start();
    ws.sockets[0].simulateDrop(4401);
    await waitFor(() => stopped);
    assert.equal(checks, 1);
    assert.equal(ws.sockets.length, 1);
  });

  it('a URL do WS leva client=pc/<versão> e protocol (§9)', () => {
    const versioned = new ApiClient({ baseUrl: 'https://api.arkivo.test', getDeviceToken: () => 'dev-tok', clientVersion: '0.3.1' });
    const u = new URL(versioned.wsUrl({ device: 'dev-tok' }));
    assert.equal(u.searchParams.get('client'), 'pc/0.3.1');
    assert.equal(u.searchParams.get('protocol'), String(PROTOCOL_VERSION));
    assert.equal(u.searchParams.get('device'), 'dev-tok');
  });

  it('fechamento 4426 (versão recusada) emite upgradeRequired e para de reconectar', async () => {
    const ws = fakeWsFactory();
    let checks = 0;
    const rt = new RealtimeClient({
      api, getDeviceToken: () => 't', wsFactory: ws.factory, getStatus: async () => status, minBackoffMs: 5, maxBackoffMs: 5,
      beforeReconnect: async () => (checks++, true),
    });
    const infos: UpgradeRequiredInfo[] = [];
    let stopped = false;
    rt.on('upgradeRequired', (i: UpgradeRequiredInfo) => infos.push(i));
    rt.on('stopped', () => (stopped = true));
    rt.start();
    ws.sockets[0].simulateDrop(WS_CLOSE.UPGRADE_REQUIRED, formatUpgradeCloseReason({ minVersion: '0.5.0', kind: 'pc', protocol: 1 }));
    await waitFor(() => stopped);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(infos, [{ minVersion: '0.5.0', kind: 'pc', protocol: 1 }]);
    assert.equal(ws.sockets.length, 1, 'não reconecta');
    assert.equal(checks, 0);
  });

  it('beforeReconnect=false (PC removido enquanto offline) para de reconectar', async () => {
    const ws = fakeWsFactory();
    const rt = new RealtimeClient({ api, getDeviceToken: () => 't', wsFactory: ws.factory, getStatus: async () => status, minBackoffMs: 5, maxBackoffMs: 5, beforeReconnect: async () => false });
    let stopped = false;
    rt.on('stopped', () => (stopped = true));
    rt.start();
    ws.sockets[0].simulateDrop();
    await waitFor(() => ws.sockets.length === 2);
    ws.sockets[1].simulateDrop();
    await waitFor(() => stopped);
    assert.equal(ws.sockets.length, 2);
  });
});

describe('net-info', () => {
  it('só IPv4 privados', () => {
    for (const ok of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20']) assert.ok(isPrivateIPv4(ok), ok);
    for (const no of ['8.8.8.8', '172.32.0.1', '169.254.1.1', '127.0.0.1', '100.64.0.1', 'fe80::1', '999.1.1.1']) assert.ok(!isPrivateIPv4(no), no);
  });
  it('filtra interfaces (sem loopback, sem IPv6, sem públicos)', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.0.10', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      wlan: [{ address: '10.1.2.3', family: 4, internal: false }],
      wan: [{ address: '200.1.2.3', family: 'IPv4', internal: false }],
    } as unknown as Parameters<typeof lanIPv4Addresses>[0];
    assert.deepEqual(lanIPv4Addresses(ifaces), ['192.168.0.10', '10.1.2.3']);
  });
});
