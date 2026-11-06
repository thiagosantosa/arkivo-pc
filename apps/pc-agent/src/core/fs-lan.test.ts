// Pastas liberadas pela LAN (contrato §10.5): assinatura com nonce/query/corpo, rotas JSON, download com Range,
// miniatura com ETag e envio em pedaços com retomada e conflito, contra o servidor LAN real em porta efêmera.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  CAPABILITIES,
  FS_PARTS_DIR_NAME,
  canonicalFsQuery,
  fsListQuery,
  randomFsId,
  signLanFsRequest,
  type FsListResponse,
  type FsUploadResult,
} from '@arkivo/shared';
import { FsLanRoutes } from './fs-lan';
import { FS_LAN_PART_MAX_AGE_MS } from './fs-lan-upload';
import { LanServer } from './lan-server';
import { Storage } from './storage';
import { fsKit, newPairKey, sha256, writeTree, type FsKit } from './test-helpers';

const pairKey = newPairKey();
const PHONE = 'phone-1';

describe('pastas liberadas na LAN: limites (§10.10)', () => {
  it('só o começo do envio conta como mudança: um arquivo em muitos pedaços não cai em RATE_LIMITED', async () => {
    // Relógio parado só no limite de taxa: o fsync de cada pedaço pode demorar, e o teste não depende disso.
    const k = await fsKit({ writePerSecond: 1, now: () => 1_000_000 });
    const root = await k.addRoot('Raiz');
    const lan = new FsLanRoutes({ service: k.service, minFreeMarginBytes: 0 });
    const server = new LanServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.1.0',
      storage: new Storage(() => null),
      getContext: () => ({ deviceId: 'pc-1', pairKey, allowedPhones: new Set([PHONE]) }),
      reportLocation: () => Promise.resolve(),
      fs: lan,
    });
    try {
      const base = `http://127.0.0.1:${await server.start()}`;
      const data = randomBytes(6000);
      const hash = sha256(data);
      const put = async (id: string, name: string, chunk: Buffer, range: string) => {
        const query = canonicalFsQuery({ rootId: root.id, path: '', name });
        const route = `/v1/fs/upload/${id}`;
        const sig = await signLanFsRequest({ pairKey, phoneDeviceId: PHONE, method: 'PUT', path: route, query, bodySha256: hash });
        return fetch(`${base}${route}?${query}`, {
          method: 'PUT',
          headers: { ...sig, 'X-Arkivo-Hash': hash, 'Content-Range': range },
          body: chunk as Uint8Array<ArrayBuffer>,
        });
      };
      const id = randomFsId();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await put(id, 'a.bin', data.subarray(i * 1000, (i + 1) * 1000), `bytes ${i * 1000}-${(i + 1) * 1000 - 1}/6000`)).status);
      }
      assert.deepEqual(statuses, [202, 202, 202, 202, 202, 200]);
      // Começar outro envio no mesmo segundo já é outra mudança.
      const again = await put(randomFsId(), 'b.bin', data.subarray(0, 1000), 'bytes 0-999/6000');
      assert.equal(again.status, 429);
      assert.equal(((await again.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    } finally {
      await server.stop();
      await k.cleanup();
    }
  });
});

describe('pastas liberadas na LAN (/v1/fs/*)', () => {
  let k: FsKit;
  let root: { id: string; abs: string };
  let server: LanServer;
  let lan: FsLanRoutes;
  let base: string;
  let free = Number.MAX_SAFE_INTEGER;

  before(async () => {
    k = await fsKit();
    root = await k.addRoot('Raiz');
    lan = new FsLanRoutes({ service: k.service, minFreeMarginBytes: 1024, freeBytes: async () => free });
    server = new LanServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.1.0',
      storage: new Storage(() => null),
      getContext: () => ({ deviceId: 'pc-1', pairKey, allowedPhones: new Set([PHONE]) }),
      reportLocation: async () => undefined,
      fs: lan,
    });
    base = `http://127.0.0.1:${await server.start()}`;
  });
  after(async () => {
    await server.stop();
    await k.cleanup();
  });
  beforeEach(async () => {
    free = Number.MAX_SAFE_INTEGER;
    await k.roots.setEnabled(true);
  });

  /** Pedido assinado como o celular (helper do shared, WebCrypto). */
  async function call(
    method: string,
    route: string,
    o: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: Buffer | string;
      hash?: string;
      headers?: Record<string, string>;
      key?: string;
      phone?: string;
      nonce?: string;
      rawQuery?: string;
    } = {},
  ): Promise<Response> {
    const query = canonicalFsQuery(o.query ?? {});
    let bodySha256 = o.hash;
    const body = typeof o.body === 'string' ? Buffer.from(o.body) : o.body;
    if (method === 'POST') bodySha256 = sha256(body ?? Buffer.alloc(0));
    const sig = await signLanFsRequest({
      pairKey: o.key ?? pairKey,
      phoneDeviceId: o.phone ?? PHONE,
      method,
      path: route,
      query,
      bodySha256,
      nonce: o.nonce,
    });
    const headers: Record<string, string> = { ...sig, ...(o.headers ?? {}) };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (o.hash) headers['X-Arkivo-Hash'] = o.hash;
    const q = o.rawQuery ?? query;
    return fetch(`${base}${route}${q ? `?${q}` : ''}`, { method, headers, body: body as Uint8Array<ArrayBuffer> | undefined });
  }

  const json = (body: unknown) => JSON.stringify(body);

  it('ping anuncia capabilities ["fs", "fs-push"] (mesmo com o interruptor desligado)', async () => {
    await k.roots.setEnabled(false);
    const r = (await (await fetch(`${base}/v1/ping`)).json()) as { capabilities?: string[] };
    assert.deepEqual(r.capabilities, [CAPABILITIES.fs, CAPABILITIES.fsPush]);
  });

  it('preflight libera POST/DELETE e os cabeçalhos novos; expõe ETag, Content-Range etc.', async () => {
    const r = await fetch(`${base}/v1/fs/list`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods')!, /POST/);
    assert.match(r.headers.get('access-control-allow-methods')!, /DELETE/);
    const allow = r.headers.get('access-control-allow-headers')!.toLowerCase();
    for (const h of ['x-arkivo-nonce', 'range', 'if-range', 'if-none-match']) assert.ok(allow.includes(h), h);
    const expose = r.headers.get('access-control-expose-headers')!.toLowerCase();
    for (const h of ['content-range', 'accept-ranges', 'content-length', 'content-disposition', 'etag', 'x-arkivo-received'])
      assert.ok(expose.includes(h), h);
  });

  it('assinatura: válida, chave errada (401), nonce repetido (401), sem nonce (401), celular fora da lista (403)', async () => {
    const ok = await call('GET', '/v1/fs/roots');
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { pcName: string }).pcName, 'PC-TESTE');
    assert.equal((await call('GET', '/v1/fs/roots', { key: newPairKey() })).status, 401);
    const nonce = randomFsId();
    assert.equal((await call('GET', '/v1/fs/roots', { nonce })).status, 200);
    const replay = await call('GET', '/v1/fs/roots', { nonce });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
    const sig = await signLanFsRequest({ pairKey, phoneDeviceId: PHONE, method: 'GET', path: '/v1/fs/roots', query: '' });
    const { 'x-arkivo-nonce': _n, ...noNonce } = sig;
    assert.equal((await fetch(`${base}/v1/fs/roots`, { headers: noNonce })).status, 401);
    assert.equal((await call('GET', '/v1/fs/roots', { phone: 'intruso' })).status, 403);
    // Assinatura do backup (§3.3) não vale aqui.
    assert.equal(
      (
        await fetch(`${base}/v1/fs/roots`, {
          headers: { 'X-Arkivo-Device': PHONE, 'X-Arkivo-Ts': String(Date.now()), 'X-Arkivo-Sig': sig['x-arkivo-sig'] },
        })
      ).status,
      401,
    );
  });

  it('query: o PC recalcula a forma canônica (cliente que recodifica não quebra); query trocada → 401; repetida → 400', async () => {
    await writeTree(root.abs, { 'Fotos (1)/a b.jpg': 'x' });
    const q = fsListQuery({ rootId: root.id, path: 'Fotos (1)', includeHidden: false });
    // URL com "(" ")" sem codificar e espaço como "+": a assinatura é sobre canonicalFsQuery.
    const raw = `includeHidden=0&path=Fotos+(1)&rootId=${root.id}`;
    const r = await call('GET', '/v1/fs/list', { query: q, rawQuery: raw });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(
      ((await r.json()) as FsListResponse).entries.map((e) => e.name),
      ['a b.jpg'],
    );
    const tampered = await call('GET', '/v1/fs/list', { query: q, rawQuery: `includeHidden=1&path=Fotos%20(1)&rootId=${root.id}` });
    assert.equal(tampered.status, 401);
    assert.equal((await call('GET', '/v1/fs/list', { query: q, rawQuery: `${raw}&path=x` })).status, 400);
  });

  it('POST JSON: corpo assinado, op da rota, 64 KiB, erros com o status do contrato', async () => {
    const body = json({ op: 'mkdir', requestId: randomFsId(), rootId: root.id, path: '', name: 'Nova' });
    const r = await call('POST', '/v1/fs/mkdir', { body });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { created: boolean }).created, true);
    // corpo trocado depois de assinar
    const sig = await signLanFsRequest({
      pairKey,
      phoneDeviceId: PHONE,
      method: 'POST',
      path: '/v1/fs/mkdir',
      query: '',
      bodySha256: sha256(body),
    });
    const swapped = await fetch(`${base}/v1/fs/mkdir`, {
      method: 'POST',
      headers: { ...sig, 'Content-Type': 'application/json' },
      body: body.replace('Nova', 'Outra'),
    });
    assert.equal(swapped.status, 401);
    assert.equal((await call('POST', '/v1/fs/rename', { body })).status, 400, 'op diferente da rota');
    assert.equal((await call('POST', '/v1/fs/mkdir', { body: 'x'.repeat(70 * 1024) })).status, 413);
    const conflict = await call('POST', '/v1/fs/mkdir', {
      body: json({ op: 'mkdir', requestId: randomFsId(), rootId: root.id, path: '', name: 'Nova' }),
    });
    assert.equal(conflict.status, 200);
    await writeTree(root.abs, { 'arquivo.txt': 'a' });
    const c409 = await call('POST', '/v1/fs/mkdir', {
      body: json({ op: 'mkdir', requestId: randomFsId(), rootId: root.id, path: '', name: 'arquivo.txt' }),
    });
    assert.equal(c409.status, 409);
    assert.equal(((await c409.json()) as { error: { code: string } }).error.code, 'CONFLICT');
    const gone = await call('GET', '/v1/fs/stat', { query: { rootId: 'raizRemovidaXYZ', path: '' } });
    assert.equal(gone.status, 410);
    const forbidden = await call('GET', '/v1/fs/stat', { query: { rootId: root.id, path: '../x' } });
    assert.equal(forbidden.status, 403);
    await k.roots.setEnabled(false);
    const off = await call('GET', '/v1/fs/roots');
    assert.equal(off.status, 403);
    assert.equal(((await off.json()) as { error: { code: string } }).error.code, 'FS_DISABLED');
  });

  it('download: 200 inteiro, Range → 206, If-Range com ETag velho → 200, faixa inválida → 416, HEAD, pasta → 400', async () => {
    const data = randomBytes(5000);
    await writeTree(root.abs, { 'dl/vídeo.mp4': data, 'dl/sub/': '' });
    const q = { rootId: root.id, path: 'dl/vídeo.mp4' };
    const full = await call('GET', '/v1/fs/download', { query: q });
    assert.equal(full.status, 200);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));
    const etag = full.headers.get('etag')!;
    assert.match(etag, /^"5000-\d+"$/);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('content-disposition'), "attachment; filename*=UTF-8''v%C3%ADdeo.mp4");
    const part = await call('GET', '/v1/fs/download', { query: q, headers: { Range: 'bytes=100-199', 'If-Range': etag } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/5000');
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(data.subarray(100, 200)));
    const open = await call('GET', '/v1/fs/download', { query: q, headers: { Range: 'bytes=4990-' } });
    assert.equal(open.status, 206);
    assert.equal((await open.arrayBuffer()).byteLength, 10);
    const stale = await call('GET', '/v1/fs/download', { query: q, headers: { Range: 'bytes=100-199', 'If-Range': '"1-1"' } });
    assert.equal(stale.status, 200);
    assert.equal((await stale.arrayBuffer()).byteLength, 5000);
    const bad = await call('GET', '/v1/fs/download', { query: q, headers: { Range: 'bytes=6000-' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */5000');
    const head = await call('HEAD', '/v1/fs/download', { query: q });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '5000');
    assert.equal((await call('GET', '/v1/fs/download', { query: { rootId: root.id, path: 'dl/sub' } })).status, 400);
    const audit = k.audit.entries().filter((e) => e.op === 'download');
    assert.ok(audit.length >= 2 && audit[0].bytes === 5000 && audit[0].via === 'lan');
  });

  it('miniatura: JPEG com ETag e Cache-Control; If-None-Match → 304; sem prévia → 404', async () => {
    await writeTree(root.abs, { 'th/a.jpg': 'imagem', 'th/b.txt': 'texto' });
    const r = await call('GET', '/v1/fs/thumb', { query: { rootId: root.id, path: 'th/a.jpg', size: 128 } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('cache-control'), 'private, max-age=300');
    const etag = r.headers.get('etag')!;
    const again = await call('GET', '/v1/fs/thumb', {
      query: { rootId: root.id, path: 'th/a.jpg', size: 128 },
      headers: { 'If-None-Match': etag },
    });
    assert.equal(again.status, 304);
    const none = await call('GET', '/v1/fs/thumb', { query: { rootId: root.id, path: 'th/b.txt' } });
    assert.equal(none.status, 404);
    assert.equal(((await none.json()) as { error: { code: string } }).error.code, 'NO_THUMBNAIL');
  });

  // ------------------------------------------------------------------ envio

  function up(uploadId: string, q: Record<string, string>, body: Buffer, o: { hash: string; range?: string }) {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (o.range) headers['Content-Range'] = o.range;
    return call('PUT', `/v1/fs/upload/${uploadId}`, { query: q, body, hash: o.hash, headers });
  }

  it('envio em um PUT só → 200 FsUploadResult; arquivo no destino; .part some; último pedaço repetido → mesmo resultado', async () => {
    await writeTree(root.abs, { 'Up/': '' });
    const data = randomBytes(3000);
    const hash = sha256(data);
    const id = randomFsId();
    const q = { rootId: root.id, path: 'Up', name: 'foto.jpg', onConflict: 'rename' };
    const r = await up(id, q, data, { hash });
    assert.equal(r.status, 200);
    const res = (await r.json()) as FsUploadResult;
    assert.deepEqual([res.path, res.verifiedHash, res.renamed, res.entry.size], ['Up/foto.jpg', hash, false, 3000]);
    assert.ok((await fsp.readFile(path.join(root.abs, 'Up', 'foto.jpg'))).equals(data));
    assert.ok(!existsSync(path.join(root.abs, FS_PARTS_DIR_NAME, `${id}.part`)));
    const repeat = await up(id, q, data, { hash });
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), res);
    const head = await call('HEAD', `/v1/fs/upload/${id}`, { query: q });
    assert.equal(head.headers.get('x-arkivo-received'), '3000');
    // mesmo nome de novo com rename → " (2)"
    const id2 = randomFsId();
    const r2 = await up(id2, { ...q }, data, { hash });
    const res2 = (await r2.json()) as FsUploadResult;
    assert.deepEqual([res2.path, res2.renamed], ['Up/foto (2).jpg', true]);
    const audit = k.audit.entries().find((e) => e.op === 'upload')!;
    assert.deepEqual([audit.path, audit.bytes, audit.via], ['Up/foto (2).jpg', 3000, 'lan']);
  });

  it('envio em pedaços com retomada: 202, HEAD, buraco → 416, reenvio do último pedaço, hash errado → 409', async () => {
    const data = randomBytes(10_000);
    const hash = sha256(data);
    const id = randomFsId();
    const q = { rootId: root.id, path: '', name: 'grande.bin', onConflict: 'fail' };
    const c1 = await up(id, q, data.subarray(0, 4000), { hash, range: 'bytes 0-3999/10000' });
    assert.equal(c1.status, 202);
    assert.equal(c1.headers.get('x-arkivo-received'), '4000');
    assert.equal((await call('HEAD', `/v1/fs/upload/${id}`, { query: q })).headers.get('x-arkivo-received'), '4000');
    const gap = await up(id, q, data.subarray(6000), { hash, range: 'bytes 6000-9999/10000' });
    assert.equal(gap.status, 416);
    assert.equal(gap.headers.get('x-arkivo-received'), '4000');
    // query diferente do começo → 400
    assert.equal((await up(id, { ...q, name: 'outro.bin' }, data.subarray(4000), { hash, range: 'bytes 4000-9999/10000' })).status, 400);
    // pedaço reenviado (start < recebido) trunca e regrava
    const c2 = await up(id, q, data.subarray(2000, 8000), { hash, range: 'bytes 2000-7999/10000' });
    assert.equal(c2.status, 202);
    assert.equal(c2.headers.get('x-arkivo-received'), '8000');
    const c3 = await up(id, q, data.subarray(8000), { hash, range: 'bytes 8000-9999/10000' });
    assert.equal(c3.status, 200);
    assert.ok((await fsp.readFile(path.join(root.abs, 'grande.bin'))).equals(data));

    const bad = randomFsId();
    const wrong = await up(bad, { ...q, name: 'errado.bin' }, data, { hash: sha256('outra coisa') });
    assert.equal(wrong.status, 409);
    assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, 'HASH_MISMATCH');
    assert.equal(wrong.headers.get('x-arkivo-received'), '0');
    assert.ok(!existsSync(path.join(root.abs, FS_PARTS_DIR_NAME, `${bad}.part`)));
    assert.ok(!existsSync(path.join(root.abs, 'errado.bin')));
  });

  it('conflito de nome com onConflict=fail → 412 no primeiro pedaço (e no final); replace manda o antigo para a Lixeira', async () => {
    await writeTree(root.abs, { 'c/existe.txt': 'antigo' });
    const data = Buffer.from('novo conteúdo');
    const hash = sha256(data);
    const q = { rootId: root.id, path: 'c', name: 'existe.txt', onConflict: 'fail' };
    const r = await up(randomFsId(), q, data, { hash });
    assert.equal(r.status, 412);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'CONFLICT');
    // nome livre no começo, ocupado no fim → 412 também, sem deixar .part
    const id = randomFsId();
    const q2 = { rootId: root.id, path: 'c', name: 'tarde.txt', onConflict: 'fail' };
    assert.equal((await up(id, q2, data.subarray(0, 5), { hash, range: `bytes 0-4/${data.length}` })).status, 202);
    await writeTree(root.abs, { 'c/tarde.txt': 'chegou antes' });
    assert.equal((await up(id, q2, data.subarray(5), { hash, range: `bytes 5-${data.length - 1}/${data.length}` })).status, 412);
    assert.ok(!existsSync(path.join(root.abs, FS_PARTS_DIR_NAME, `${id}.part`)));
    const rep = await up(randomFsId(), { ...q, onConflict: 'replace' }, data, { hash });
    assert.equal(rep.status, 200);
    assert.equal(await fsp.readFile(path.join(root.abs, 'c', 'existe.txt'), 'utf8'), 'novo conteúdo');
    assert.ok(
      k.trashCalls.some((p) => p.endsWith('existe.txt')),
      'o antigo foi para a Lixeira',
    );
    k.volume.trash = false;
    try {
      const noTrash = await up(randomFsId(), { ...q, onConflict: 'replace' }, data, { hash });
      assert.equal(noTrash.status, 422);
      assert.equal(((await noTrash.json()) as { error: { code: string } }).error.code, 'TRASH_UNAVAILABLE');
    } finally {
      k.volume.trash = true;
    }
  });

  it('pouco espaço → 507; DELETE cancela e apaga o .part; nome inválido → 400', async () => {
    const data = randomBytes(2000);
    const hash = sha256(data);
    free = 100;
    const r = await up(randomFsId(), { rootId: root.id, path: '', name: 'x.bin' }, data, { hash });
    assert.equal(r.status, 507);
    free = Number.MAX_SAFE_INTEGER;
    const id = randomFsId();
    const q = { rootId: root.id, path: '', name: 'cancelar.bin' };
    assert.equal((await up(id, q, data.subarray(0, 1000), { hash, range: 'bytes 0-999/2000' })).status, 202);
    assert.ok(existsSync(path.join(root.abs, FS_PARTS_DIR_NAME, `${id}.part`)));
    const del = await call('DELETE', `/v1/fs/upload/${id}`, { query: { rootId: root.id } });
    assert.equal(del.status, 204);
    assert.ok(!existsSync(path.join(root.abs, FS_PARTS_DIR_NAME, `${id}.part`)));
    assert.equal((await call('DELETE', `/v1/fs/upload/${id}`, { query: { rootId: root.id } })).status, 204, 'idempotente');
    const badName = await up(randomFsId(), { rootId: root.id, path: '', name: 'a:b.txt' }, data, { hash });
    assert.equal(badName.status, 400);
    assert.equal(((await badName.json()) as { error: { code: string } }).error.code, 'INVALID_NAME');
  });

  it('limpeza na partida: .part parado há mais de 7 dias é apagado', async () => {
    const parts = path.join(root.abs, FS_PARTS_DIR_NAME);
    await writeTree(parts, { 'velho.part': 'x', 'velho.json': '{"v":1}', 'novo.part': 'y' });
    const old = new Date(Date.now() - FS_LAN_PART_MAX_AGE_MS - 60_000);
    await fsp.utimes(path.join(parts, 'velho.part'), old, old);
    await lan.cleanup();
    assert.ok(!existsSync(path.join(parts, 'velho.part')));
    assert.ok(!existsSync(path.join(parts, 'velho.json')));
    assert.ok(existsSync(path.join(parts, 'novo.part')));
  });
});
