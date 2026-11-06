process.env.TZ = 'America/Sao_Paulo';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, type LocationReport } from '@arkivo/shared';
import { LanCompletedEvent, LanServer } from './lan-server';
import { PARTS_DIR_NAME, Storage } from './storage';
import { assertOrder, errno, isMark, isOp, newPairKey, sha256, signedHeaders, spyFs, tempDir, waitFor } from './test-helpers';

const pairKey = newPairKey();
const PHONE = 'phone-1';
const PC_ID = 'pc-123';

describe('servidor LAN (porta efêmera, disco temporário)', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let server: LanServer;
  let base: string;
  let reports: { fileId: string; report: LocationReport }[];
  let completed: LanCompletedEvent[];
  let free = Number.MAX_SAFE_INTEGER;

  before(async () => {
    ({ dir: root, cleanup } = await tempDir());
    const storage = new Storage(() => root);
    server = new LanServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.1.0',
      storage,
      minFreeMarginBytes: 1024,
      freeBytes: async () => free,
      getContext: () => ({ deviceId: PC_ID, pairKey, allowedPhones: new Set([PHONE]) }),
      reportLocation: async (fileId, report) => {
        reports.push({ fileId, report });
      },
    });
    server.on('completed', (e: LanCompletedEvent) => completed.push(e));
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await server.stop();
    await cleanup();
  });
  beforeEach(() => {
    reports = [];
    completed = [];
    free = Number.MAX_SAFE_INTEGER;
  });

  function put(fileId: string, body: Buffer, o: { hash: string; name: string; takenAt?: string; range?: string; key?: string; phone?: string }) {
    const p = `/v1/files/${fileId}`;
    const headers: Record<string, string> = {
      ...signedHeaders({ pairKey: o.key ?? pairKey, phoneId: o.phone ?? PHONE, method: 'PUT', path: p, hash: o.hash }),
      'X-Arkivo-Name': encodeURIComponent(o.name),
      'X-Arkivo-Taken-At': o.takenAt ?? '2026-11-03T13:30:00.000Z',
      'X-Arkivo-Kind': 'photo',
      'Content-Type': 'application/octet-stream',
    };
    if (o.range) headers['Content-Range'] = o.range;
    return fetch(base + p, { method: 'PUT', headers, body });
  }

  function head(fileId: string) {
    const p = `/v1/files/${fileId}`;
    return fetch(base + p, { method: 'HEAD', headers: signedHeaders({ pairKey, phoneId: PHONE, method: 'HEAD', path: p }) });
  }

  it('GET /v1/ping responde sem assinatura e informa o protocolo (§9)', async () => {
    const r = await fetch(`${base}/v1/ping`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { app: 'arkivo-pc', deviceId: PC_ID, version: '0.1.0', protocol: PROTOCOL_VERSION, minProtocol: MIN_PROTOCOL_VERSION });
  });

  it('ping responde 200 com o protocolo mesmo para celular incompatível (é assim que ele descobre)', async () => {
    const r = await fetch(`${base}/v1/ping`, { headers: { 'X-Arkivo-Client': 'mobile/9.0.0', 'X-Arkivo-Protocol': String(PROTOCOL_VERSION + 1) } });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { protocol: number }).protocol, PROTOCOL_VERSION);
  });

  it('celular com protocolo incompatível → 426 UPGRADE_REQUIRED, antes da assinatura', async () => {
    const body = randomBytes(1000);
    const p = '/v1/files/proto1';
    const r = await fetch(base + p, {
      method: 'PUT',
      headers: {
        // Assinatura propositalmente errada: o protocolo é conferido antes (o formato pode mudar entre protocolos).
        ...signedHeaders({ pairKey: newPairKey(), phoneId: PHONE, method: 'PUT', path: p, hash: sha256(body) }),
        'X-Arkivo-Client': 'mobile/2.0.0',
        'X-Arkivo-Protocol': String(PROTOCOL_VERSION + 1),
        'X-Arkivo-Name': 'a.jpg',
      },
      body,
    });
    assert.equal(r.status, 426);
    const err = ((await r.json()) as { error: Record<string, unknown> }).error;
    assert.deepEqual({ code: err.code, kind: err.kind, minVersion: err.minVersion, protocol: err.protocol }, { code: 'UPGRADE_REQUIRED', kind: 'mobile', minVersion: null, protocol: PROTOCOL_VERSION });
    assert.equal(existsSync(path.join(root, '.arkivo-parciais', 'proto1.part')), false);
  });

  it('protocolo compatível ou sem cabeçalho segue normalmente; malformado → 400', async () => {
    const p = '/v1/files/proto2';
    const sig = () => signedHeaders({ pairKey, phoneId: PHONE, method: 'HEAD', path: p });
    assert.equal((await fetch(base + p, { method: 'HEAD', headers: { ...sig(), 'X-Arkivo-Client': 'mobile/0.1.0', 'X-Arkivo-Protocol': String(PROTOCOL_VERSION) } })).status, 200);
    assert.equal((await fetch(base + p, { method: 'HEAD', headers: sig() })).status, 200);
    assert.equal((await fetch(base + p, { method: 'HEAD', headers: { ...sig(), 'X-Arkivo-Protocol': 'v1' } })).status, 400);
  });

  it('OPTIONS responde ao preflight (CORS + Private Network Access)', async () => {
    const r = await fetch(`${base}/v1/files/x`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-private-network'), 'true');
    assert.match(r.headers.get('access-control-allow-headers') ?? '', /X-Arkivo-Sig/);
    // Cabeçalhos que o celular manda num PUT/HEAD precisam estar liberados, e o X-Arkivo-Received exposto.
    const allowed = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
    for (const h of ['content-type', 'content-range', 'x-arkivo-device', 'x-arkivo-ts', 'x-arkivo-sig', 'x-arkivo-hash', 'x-arkivo-name', 'x-arkivo-taken-at', 'x-arkivo-kind', 'x-arkivo-client', 'x-arkivo-protocol']) {
      assert.ok(allowed.includes(h), `falta ${h} em Access-Control-Allow-Headers`);
    }
    assert.ok((r.headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/\s*,\s*/).includes('x-arkivo-received'));
    assert.match(r.headers.get('access-control-allow-methods') ?? '', /PUT/);
  });

  it('respostas normais também expõem X-Arkivo-Received (CORS)', async () => {
    const r = await head('nada-cors');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.ok((r.headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/\s*,\s*/).includes('x-arkivo-received'));
  });

  it('PATH assinado não inclui a query (§3.3)', async () => {
    const p = '/v1/files/comquery';
    const ok = await fetch(`${base}${p}?x=1`, { method: 'HEAD', headers: signedHeaders({ pairKey, phoneId: PHONE, method: 'HEAD', path: p }) });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}${p}?x=1`, { method: 'HEAD', headers: signedHeaders({ pairKey, phoneId: PHONE, method: 'HEAD', path: `${p}?x=1` }) });
    assert.equal(bad.status, 401);
  });

  it('HEAD sem nada recebido → X-Arkivo-Received: 0', async () => {
    const r = await head('nada');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-arkivo-received'), '0');
  });

  it('upload completo num PUT: confere hash, organiza e reporta à API', async () => {
    const body = randomBytes(64 * 1024);
    const hash = sha256(body);
    const r = await put('file1', body, { hash, name: 'IMG_20261103_103000.jpg' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { relativePath: '2026/11/IMG_20261103_103000.jpg', verifiedHash: hash });
    const saved = await fsp.readFile(path.join(root, '2026', '11', 'IMG_20261103_103000.jpg'));
    assert.ok(saved.equals(body));
    assert.deepEqual(reports, [{ fileId: 'file1', report: { relativePath: '2026/11/IMG_20261103_103000.jpg', verifiedHash: hash } }]);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].phoneId, PHONE);
    assert.equal(existsSync(path.join(root, '.arkivo-parciais', 'file1.part')), false);
  });

  it('retomada com Content-Range: pedaço 1 → 202, HEAD mostra bytes, pedaço 2 → 200', async () => {
    const body = randomBytes(300_000);
    const hash = sha256(body);
    const total = body.length;
    const cut = 120_000;
    const r1 = await put('file2', body.subarray(0, cut), { hash, name: 'VID_1.mp4', range: `bytes 0-${cut - 1}/${total}` });
    assert.equal(r1.status, 202);
    assert.equal(r1.headers.get('x-arkivo-received'), String(cut));
    await r1.arrayBuffer();

    const h = await head('file2');
    assert.equal(h.headers.get('x-arkivo-received'), String(cut));

    // Pedaço fora de ordem (pulando bytes) → 416 com o que já existe.
    const skip = await put('file2', body.subarray(cut + 10), { hash, name: 'VID_1.mp4', range: `bytes ${cut + 10}-${total - 1}/${total}` });
    assert.equal(skip.status, 416);
    assert.equal(skip.headers.get('x-arkivo-received'), String(cut));
    await skip.arrayBuffer();

    const r2 = await put('file2', body.subarray(cut), { hash, name: 'VID_1.mp4', range: `bytes ${cut}-${total - 1}/${total}` });
    assert.equal(r2.status, 200);
    const res = (await r2.json()) as { relativePath: string };
    assert.equal(res.relativePath, '2026/11/VID_1.mp4');
    assert.ok((await fsp.readFile(path.join(root, '2026', '11', 'VID_1.mp4'))).equals(body));
  });

  it('conexão cai no meio do PUT → .part fica e o celular retoma do ponto (HEAD)', async () => {
    const body = randomBytes(400_000);
    const hash = sha256(body);
    const p = '/v1/files/fileDrop';
    const sent = 150_000;
    await new Promise<void>((resolve) => {
      const req = http.request(base + p, {
        method: 'PUT',
        headers: {
          ...signedHeaders({ pairKey, phoneId: PHONE, method: 'PUT', path: p, hash }),
          'X-Arkivo-Name': 'VID_drop.mp4',
          'Content-Length': String(body.length),
        },
      });
      req.on('error', () => resolve());
      req.write(body.subarray(0, sent), () => setTimeout(() => {
        req.destroy();
        resolve();
      }, 50));
    });
    let received = 0;
    await waitFor(async () => {
      const h = await head('fileDrop');
      received = Number(h.headers.get('x-arkivo-received'));
      return received === sent;
    }, 3000, '.part com os bytes enviados');
    const r = await put('fileDrop', body.subarray(received), { hash, name: 'VID_drop.mp4', range: `bytes ${received}-${body.length - 1}/${body.length}` });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    assert.ok((await fsp.readFile(path.join(root, '2026', '11', 'VID_drop.mp4'))).equals(body));
  });

  it('reenvio de pedaço já recebido sobrescreve a partir do início do pedaço', async () => {
    const body = randomBytes(50_000);
    const hash = sha256(body);
    const t = body.length;
    await (await put('file3', body.subarray(0, 30_000), { hash, name: 'a.bin', range: `bytes 0-29999/${t}` })).arrayBuffer();
    // Celular perdeu a resposta e manda de novo a partir de 20000.
    await (await put('file3', body.subarray(20_000, 30_000), { hash, name: 'a.bin', range: `bytes 20000-29999/${t}` })).arrayBuffer();
    const r = await put('file3', body.subarray(30_000), { hash, name: 'a.bin', range: `bytes 30000-${t - 1}/${t}` });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  });

  it('.part completo sem confirmação: celular reenvia o último pedaço (start < recebido) e o PC conclui', async () => {
    const body = randomBytes(40_000);
    const hash = sha256(body);
    const t = body.length;
    const r1 = await put('file3b', body.subarray(0, 30_000), { hash, name: 'b.bin', range: `bytes 0-29999/${t}` });
    assert.equal(r1.status, 202);
    await r1.arrayBuffer();
    // Simula a resposta do último pedaço perdida: o .part já tem tudo, mas não foi finalizado.
    const storage = new Storage(() => root);
    await fsp.writeFile(storage.partPath('file3b'), body);
    const h = await head('file3b');
    assert.equal(h.headers.get('x-arkivo-received'), String(t));
    const r = await put('file3b', body.subarray(32_000), { hash, name: 'b.bin', range: `bytes 32000-${t - 1}/${t}` });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { verifiedHash: string }).verifiedHash, hash);
    assert.ok((await fsp.readFile(path.join(root, '2026', '11', 'b.bin'))).equals(body));
  });

  it('mesmo arquivo em duas conexões ao mesmo tempo → 423 (não 409, que é hash errado)', async () => {
    const body = randomBytes(100_000);
    const hash = sha256(body);
    const p = '/v1/files/fileBusy';
    let first!: http.ClientRequest;
    await new Promise<void>((resolve) => {
      first = http.request(base + p, {
        method: 'PUT',
        headers: {
          ...signedHeaders({ pairKey, phoneId: PHONE, method: 'PUT', path: p, hash }),
          'X-Arkivo-Name': 'busy.bin',
          'Content-Length': String(body.length),
        },
      });
      first.on('error', () => undefined);
      first.write(body.subarray(0, 10_000), () => setTimeout(resolve, 50));
    });
    const r = await put('fileBusy', body, { hash, name: 'busy.bin' });
    assert.equal(r.status, 423);
    await r.arrayBuffer();
    first.destroy();
  });

  it('hash errado → 409 e o .part é apagado', async () => {
    const body = randomBytes(10_000);
    const wrong = sha256('outra coisa');
    const r = await put('file4', body, { hash: wrong, name: 'x.jpg' });
    assert.equal(r.status, 409);
    const err = (await r.json()) as { error: { code: string } };
    assert.equal(err.error.code, 'CONFLICT');
    assert.equal(existsSync(path.join(root, '.arkivo-parciais', 'file4.part')), false);
    assert.equal(reports.length, 0);
    const h = await head('file4');
    assert.equal(h.headers.get('x-arkivo-received'), '0');
  });

  it('pouco espaço livre (menos que tamanho + folga) → 507', async () => {
    free = 5_000;
    const body = randomBytes(10_000);
    const r = await put('file5', body, { hash: sha256(body), name: 'grande.mp4' });
    assert.equal(r.status, 507);
    const err = (await r.json()) as { error: { code: string } };
    assert.equal(err.error.code, 'QUOTA_EXCEEDED');
    assert.equal(existsSync(path.join(root, '2026', '11', 'grande.mp4')), false);
  });

  it('assinatura de outro usuário → 401; celular fora dos peers → 403', async () => {
    const body = Buffer.from('oi');
    const r1 = await put('file6', body, { hash: sha256(body), name: 'a.txt', key: newPairKey() });
    assert.equal(r1.status, 401);
    await r1.arrayBuffer();
    const r2 = await put('file6', body, { hash: sha256(body), name: 'a.txt', phone: 'phone-intruso' });
    assert.equal(r2.status, 403);
    await r2.arrayBuffer();
    const r3 = await fetch(`${base}/v1/files/file6`, { method: 'HEAD' });
    assert.equal(r3.status, 401);
  });

  it('nome com ../ é sanitizado e fica dentro da pasta', async () => {
    const body = Buffer.from('conteudo');
    const r = await put('file7', body, { hash: sha256(body), name: '../../../etc/passwd' });
    assert.equal(r.status, 200);
    const { relativePath } = (await r.json()) as { relativePath: string };
    assert.equal(relativePath, '2026/11/passwd');
    assert.ok(existsSync(path.join(root, '2026', '11', 'passwd')));
  });

  it('mesmo arquivo reenviado = idempotente; nome igual com conteúdo diferente = " (2)"', async () => {
    const a = Buffer.from('versao A');
    const b = Buffer.from('versao B');
    const r1 = await put('dupA', a, { hash: sha256(a), name: 'Gastos_casa.xlsx' });
    assert.equal(((await r1.json()) as { relativePath: string }).relativePath, '2026/11/Gastos_casa.xlsx');
    const r2 = await put('dupA', a, { hash: sha256(a), name: 'Gastos_casa.xlsx' });
    assert.equal(((await r2.json()) as { relativePath: string }).relativePath, '2026/11/Gastos_casa.xlsx');
    assert.equal(completed[1].alreadyExisted, true);
    const r3 = await put('dupB', b, { hash: sha256(b), name: 'Gastos_casa.xlsx' });
    assert.equal(((await r3.json()) as { relativePath: string }).relativePath, '2026/11/Gastos_casa (2).xlsx');
  });

  it('arquivo vazio funciona', async () => {
    const body = Buffer.alloc(0);
    const r = await put('empty1', body, { hash: sha256(body), name: 'vazio.txt' });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  });

  it('rotas desconhecidas e miniatura → 404', async () => {
    assert.equal((await fetch(`${base}/v1/nada`)).status, 404);
    const p = '/v1/files/file1/thumbnail';
    const r = await fetch(base + p, { headers: signedHeaders({ pairKey, phoneId: PHONE, method: 'GET', path: p }) });
    assert.equal(r.status, 404);
  });

  it('ID de arquivo com caracteres perigosos → 400', async () => {
    const p = '/v1/files/..%2F..%2Fx';
    const r = await fetch(base + p, { method: 'HEAD', headers: signedHeaders({ pairKey, phoneId: PHONE, method: 'HEAD', path: p }) });
    assert.equal(r.status, 400);
  });
});

describe('servidor LAN: durabilidade antes de "conferido"', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let server: LanServer;
  let storage: Storage;
  let base: string;
  let reports: string[];
  let onReport: () => void = () => {};

  before(async () => {
    ({ dir: root, cleanup } = await tempDir());
    storage = new Storage(() => root);
    server = new LanServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.1.0',
      storage,
      minFreeMarginBytes: 0,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      getContext: () => ({ deviceId: PC_ID, pairKey, allowedPhones: new Set([PHONE]) }),
      reportLocation: (fileId) => {
        onReport();
        reports.push(fileId);
        return Promise.resolve();
      },
    });
    base = `http://127.0.0.1:${await server.start()}`;
  });
  after(async () => {
    await server.stop();
    await cleanup();
  });
  beforeEach(() => {
    reports = [];
    onReport = () => {};
  });

  function put(fileId: string, body: Buffer, o: { hash: string; name: string; takenAt?: string; range?: string }) {
    const p = `/v1/files/${fileId}`;
    const headers: Record<string, string> = {
      ...signedHeaders({ pairKey, phoneId: PHONE, method: 'PUT', path: p, hash: o.hash }),
      'X-Arkivo-Name': encodeURIComponent(o.name),
      'X-Arkivo-Taken-At': o.takenAt ?? '2026-11-03T13:30:00.000Z',
      'Content-Type': 'application/octet-stream',
    };
    if (o.range) headers['Content-Range'] = o.range;
    return fetch(base + p, { method: 'PUT', headers, body });
  }

  /** Marca o SHA-256 na linha do tempo do espião. */
  function markHash(spy: Awaited<ReturnType<typeof spyFs>>) {
    const real = storage.hashFile.bind(storage);
    return mock.method(storage, 'hashFile', (file: string) => {
      spy.mark('hash', path.resolve(file));
      return real(file);
    });
  }

  it('ordem: escrita → fh.sync → close → SHA-256 → rename → fsync dos diretórios → report → 200', async () => {
    const body = randomBytes(256 * 1024);
    const hash = sha256(body);
    const part = storage.partPath('ordem1');
    const destDir = path.join(root, '2025', '03');
    const dest = path.join(destDir, 'ordem.jpg');
    const spy = await spyFs();
    const h = markHash(spy);
    onReport = () => spy.mark('report');
    let status: number;
    try {
      // Mês novo: cria 2025/ e 2025/03/ (os pais também precisam de fsync).
      const r = await put('ordem1', body, { hash, name: 'ordem.jpg', takenAt: '2025-03-10T15:00:00.000Z' });
      status = r.status;
      await r.arrayBuffer();
      spy.mark('resposta');
    } finally {
      h.mock.restore();
      spy.restore();
    }
    assert.equal(status, 200);
    const [, iSync] = assertOrder(spy.events, [
      ['escrita no .part', isOp('write', part)],
      ['fh.sync do .part', isOp('sync', part)],
      ['close do .part', isOp('close', part)],
      ['SHA-256', (e) => isMark('hash')(e) && e.extra === path.resolve(part)],
      ['fsync da raiz (pasta 2025 nova)', isOp('sync', root)],
      ['fsync de 2025 (pasta 03 nova)', isOp('sync', path.join(root, '2025'))],
      ['rename .part → destino', (e) => e.op === 'rename' && e.path === path.resolve(part) && e.extra === path.resolve(dest)],
      ['fsync do diretório de destino', isOp('sync', destDir)],
      ['fsync da pasta de parciais', isOp('sync', path.join(root, PARTS_DIR_NAME))],
      ['reportLocation', isMark('report')],
      ['resposta 200 ao celular', isMark('resposta')],
    ]);
    assert.ok(!spy.events.slice(iSync).some(isOp('write', part)), 'nada é escrito no .part depois do fsync');
    assert.ok((await fsp.readFile(dest)).equals(body));
  });

  it('cada pedaço aceito (202) passou por fsync antes da resposta', async () => {
    const body = randomBytes(50_000);
    const part = storage.partPath('pedaco1');
    const spy = await spyFs();
    try {
      const r = await put('pedaco1', body.subarray(0, 20_000), { hash: sha256(body), name: 'p.bin', range: `bytes 0-19999/${body.length}` });
      assert.equal(r.status, 202);
      await r.arrayBuffer();
      spy.mark('resposta');
    } finally {
      spy.restore();
    }
    assertOrder(spy.events, [
      ['fh.sync do .part', isOp('sync', part)],
      ['close do .part', isOp('close', part)],
      ['resposta 202', isMark('resposta')],
    ]);
  });

  it('fh.sync do .part falha com ENOSPC → 507, nada reportado, .part apagado (conteúdo não confiável)', async () => {
    const body = randomBytes(30_000);
    const part = storage.partPath('falhaSync');
    const spy = await spyFs((op, p) => (op === 'sync' && p === path.resolve(part) ? errno('ENOSPC', 'fsync') : undefined));
    let r: Response;
    try {
      r = await put('falhaSync', body, { hash: sha256(body), name: 'falha.jpg' });
    } finally {
      spy.restore();
    }
    assert.equal(r.status, 507);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'QUOTA_EXCEEDED');
    assert.equal(r.headers.get('x-arkivo-received'), '0');
    assert.deepEqual(reports, []);
    assert.equal(existsSync(part), false);
    assert.equal(existsSync(path.join(root, '2026', '11', 'falha.jpg')), false);
    assert.ok(!spy.events.some((e) => e.op === 'rename' && e.path === path.resolve(part)), 'sem rename');
  });

  it('fh.sync falha com EIO → 500, não conferido; o reenvio depois conclui', async () => {
    const body = randomBytes(30_000);
    const hash = sha256(body);
    const part = storage.partPath('falhaEio');
    const spy = await spyFs((op, p) => (op === 'sync' && p === path.resolve(part) ? errno('EIO', 'fsync') : undefined));
    let r: Response;
    try {
      r = await put('falhaEio', body, { hash, name: 'eio.jpg' });
    } finally {
      spy.restore();
    }
    assert.equal(r.status, 500);
    await r.arrayBuffer();
    assert.deepEqual(reports, []);
    const ok = await put('falhaEio', body, { hash, name: 'eio.jpg' });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { verifiedHash: string }).verifiedHash, hash);
    assert.deepEqual(reports, ['falhaEio']);
  });

  it('ENOSPC no meio da escrita de um pedaço → 507 com o .part de volta ao início do pedaço; a retomada conclui', async () => {
    const body = randomBytes(1_500_000);
    const hash = sha256(body);
    const total = body.length;
    const cut = 200_000;
    const part = storage.partPath('cheio1');
    const r1 = await put('cheio1', body.subarray(0, cut), { hash, name: 'cheio.mp4', range: `bytes 0-${cut - 1}/${total}` });
    assert.equal(r1.status, 202);
    await r1.arrayBuffer();

    let writes = 0;
    const spy = await spyFs((op, p) => (op === 'write' && p === path.resolve(part) && ++writes === 2 ? errno('ENOSPC') : undefined));
    let r2: Response;
    try {
      r2 = await put('cheio1', body.subarray(cut), { hash, name: 'cheio.mp4', range: `bytes ${cut}-${total - 1}/${total}` });
      assert.equal(r2.status, 507);
      await r2.arrayBuffer();
    } finally {
      spy.restore();
    }
    assert.ok(writes >= 2, 'a falha aconteceu no meio do pedaço');
    assert.equal(r2.headers.get('x-arkivo-received'), String(cut));
    assert.equal((await fsp.stat(part)).size, cut, '.part voltou para o fim do último pedaço aceito');
    assert.ok(!spy.events.some(isOp('sync', part)), 'sem fsync depois da escrita que falhou');
    assert.deepEqual(reports, []);

    const r3 = await put('cheio1', body.subarray(cut), { hash, name: 'cheio.mp4', range: `bytes ${cut}-${total - 1}/${total}` });
    assert.equal(r3.status, 200);
    await r3.arrayBuffer();
    assert.ok((await fsp.readFile(path.join(root, '2026', '11', 'cheio.mp4'))).equals(body));
  });
});
