// Pastas liberadas pela internet (contrato §10.6–§10.8): o teste faz o papel do celular com os helpers do shared
// (envelope AES-GCM, chaves HKDF, blobs em pedaços) e de uma API falsa para os blobs.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  FS_BLOB_SEGMENT_BYTES,
  deriveFsE2eKeys,
  fsBlobCipherSize,
  fsBlobSegment,
  newFsBlobSalt,
  openFsEnvelope,
  randomFsId,
  sealFsEnvelope,
  type FsDownloadPrepared,
  type FsE2eKeys,
  type FsEnvelope,
  type FsEvent,
  type FsListResponse,
  type FsRpcResult,
  type FsUploadStatusResponse,
  type WsMessage,
} from '@arkivo/shared';
import { ApiClient } from './api-client';
import { FsRemote } from './fs-remote';
import { fsKit, json, newPairKey, sha256, startFakeApi, waitFor, writeTree, type FsKit } from './test-helpers';

const PC_ID = 'pc-123';
const PHONE = 'phone-1';

interface FakeBlob {
  id: string;
  direction: 'toPc' | 'toPhone';
  status: string;
  cipherSize: number;
  data: Buffer;
  hash: string | null;
}

interface FakeApiState {
  blobs: Map<string, FakeBlob>;
  deleted: string[];
  fails: { id: string; reason: string }[];
  puts: string[];
  /** Próximos PUTs que respondem 503. */
  failPuts: number;
  /** Corta o próximo GET de conteúdo depois de N bytes. */
  dropGetAfter: number | null;
  getRanges: string[];
  getDelayMs: number;
  onCreate?: () => Promise<void>;
}

function info(b: FakeBlob) {
  const now = new Date().toISOString();
  return {
    id: b.id,
    pcDeviceId: PC_ID,
    direction: b.direction,
    status: b.status,
    cipherSize: b.cipherSize,
    bytesReceived: b.data.length,
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
  };
}

async function fakeApi() {
  const st: FakeApiState = {
    blobs: new Map(),
    deleted: [],
    fails: [],
    puts: [],
    failPuts: 0,
    dropGetAfter: null,
    getRanges: [],
    getDelayMs: 0,
  };
  let n = 0;
  const api = await startFakeApi(async (req, res, body) => {
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/v1/fs-blobs') {
      await st.onCreate?.();
      const id = `blob${String(++n).padStart(6, '0')}`;
      const b: FakeBlob = {
        id,
        direction: 'toPhone',
        status: 'uploading',
        cipherSize: (JSON.parse(body.toString()) as { cipherSize: number }).cipherSize,
        data: Buffer.alloc(0),
        hash: null,
      };
      st.blobs.set(id, b);
      return json(res, 201, info(b));
    }
    const m = /^\/v1\/fs-blobs\/([^/]+)(\/content|\/fail)?$/.exec(url.pathname);
    const b = m ? st.blobs.get(m[1]) : undefined;
    if (!m || !b) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'blob' } });
    if (!m[2] && req.method === 'GET') return json(res, 200, info(b));
    if (!m[2] && req.method === 'DELETE') {
      st.deleted.push(b.id);
      b.status = 'done';
      return json(res, 204);
    }
    if (m[2] === '/fail') {
      st.fails.push({ id: b.id, reason: (JSON.parse(body.toString()) as { reason: string }).reason });
      b.status = 'failed';
      return json(res, 204);
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'X-Arkivo-Received': String(b.data.length) }).end();
      return;
    }
    if (req.method === 'PUT') {
      st.puts.push(String(req.headers['content-range'] ?? 'inteiro'));
      if (st.failPuts > 0) {
        st.failPuts--;
        return json(res, 503, { error: { code: 'INTERNAL', message: 'fora' } });
      }
      const hash = String(req.headers['x-arkivo-hash']);
      if (b.hash && b.hash !== hash) return json(res, 409, { error: { code: 'CONFLICT', message: 'hash' } });
      b.hash = hash;
      const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
      const start = cr ? Number(cr[1]) : 0;
      if (start > b.data.length) {
        res.writeHead(416, { 'X-Arkivo-Received': String(b.data.length) }).end();
        return;
      }
      b.data = Buffer.concat([b.data.subarray(0, start), body]);
      if (b.data.length < b.cipherSize) {
        res.writeHead(202, { 'X-Arkivo-Received': String(b.data.length) }).end();
        return;
      }
      if (createHash('sha256').update(b.data).digest('hex') !== hash) {
        b.data = Buffer.alloc(0);
        return json(res, 409, { error: { code: 'CONFLICT', message: 'hash' } });
      }
      b.status = 'ready';
      return json(res, 200, info(b));
    }
    if (req.method === 'GET' && m[2] === '/content') {
      if (st.getDelayMs) await new Promise((r) => setTimeout(r, st.getDelayMs));
      const range = req.headers.range;
      st.getRanges.push(range ?? '');
      let start = 0;
      if (range) start = Number(/^bytes=(\d+)-$/.exec(range)![1]);
      const slice = b.data.subarray(start);
      res.writeHead(range ? 206 : 200, {
        'Content-Length': String(slice.length),
        ...(range ? { 'Content-Range': `bytes ${start}-${b.data.length - 1}/${b.data.length}` } : {}),
      });
      const drop = st.dropGetAfter;
      if (drop !== null) {
        st.dropGetAfter = null;
        res.write(slice.subarray(0, drop), () => setTimeout(() => res.socket?.destroy(), 20));
        return;
      }
      res.end(slice);
      return;
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: url.pathname } });
  });
  return { st, api };
}

/** Celular: cifra o arquivo num blob `toPc` e o deixa "pronto" na API falsa. */
async function phoneUploadsBlob(st: FakeApiState, keys: FsE2eKeys, content: Buffer) {
  const blobId = `up${randomFsId(9)}`;
  const salt = newFsBlobSalt();
  const key = await keys.blobKey(blobId, salt, content.length);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < key.segmentCount; i++) {
    const s = fsBlobSegment(content.length, i);
    parts.push(await key.sealSegment(i, new Uint8Array(content.subarray(s.plainStart, s.plainStart + s.plainLength))));
  }
  const data = Buffer.concat(parts);
  st.blobs.set(blobId, { id: blobId, direction: 'toPc', status: 'ready', cipherSize: data.length, data, hash: sha256(data) });
  return { blobId, salt };
}

/** Celular: decifra um blob `toPhone` pedaço a pedaço. */
async function phoneOpensBlob(st: FakeApiState, keys: FsE2eKeys, p: FsDownloadPrepared): Promise<Buffer> {
  const b = st.blobs.get(p.blobId)!;
  const key = await keys.blobKey(p.blobId, p.blobSalt, p.size);
  const out: Buffer[] = [];
  for (let i = 0; i < key.segmentCount; i++) {
    const s = fsBlobSegment(p.size, i);
    out.push(Buffer.from(await key.openSegment(i, new Uint8Array(b.data.subarray(s.cipherStart, s.cipherStart + s.cipherLength)))));
  }
  return Buffer.concat(out);
}

describe('pastas liberadas pela internet (RPC cifrado + blobs)', () => {
  const pairKey = newPairKey();
  let keys: FsE2eKeys;
  let k: FsKit;
  let root: { id: string; abs: string };
  let fake: Awaited<ReturnType<typeof fakeApi>>;
  let remote: FsRemote;
  let sent: WsMessage[];
  let allowed: Set<string>;
  let commitWaitMs = 15_000;

  before(async () => {
    keys = await deriveFsE2eKeys(pairKey, PC_ID);
    fake = await fakeApi();
  });
  after(async () => {
    await fake.api.close();
  });
  beforeEach(async () => {
    k = await fsKit();
    root = await k.addRoot('Raiz');
    sent = [];
    allowed = new Set([PHONE]);
    commitWaitMs = 15_000;
    fake.st.failPuts = 0;
    fake.st.dropGetAfter = null;
    fake.st.getDelayMs = 0;
    fake.st.onCreate = undefined;
    remote = new FsRemote({
      service: k.service,
      api: new ApiClient({ baseUrl: fake.api.url, getDeviceToken: () => 'tok' }),
      send: (m) => {
        sent.push(m);
        return true;
      },
      getCreds: () => ({ deviceId: PC_ID, pairKey, allowedPhones: allowed }),
      dataDir: k.dataDir,
      minFreeMarginBytes: 0,
      retryBaseMs: 5,
      get commitWaitMs() {
        return commitWaitMs;
      },
    });
    await remote.load();
  });
  afterEach(async () => {
    await remote.whenIdle();
    await k.cleanup();
  });

  /** Celular manda um pedido; devolve a resposta aberta (ou o erro em texto claro). */
  async function rpc<T = unknown>(
    payload: unknown,
    o: { phone?: string; asPhone?: string; now?: number; envelope?: FsEnvelope; keys?: FsE2eKeys } = {},
  ) {
    const env = o.envelope ?? (await sealFsEnvelope(o.keys ?? keys, { phone: o.asPhone ?? PHONE, typ: 'req', now: o.now }, payload));
    const rpcId = randomFsId();
    const before = sent.length;
    await remote.handleRequest({ rpcId, phoneDeviceId: o.phone ?? PHONE, envelope: env });
    const msg = sent.slice(before).find((m) => m.type === 'fs.response' && m.data.rpcId === rpcId);
    assert.ok(msg && msg.type === 'fs.response');
    if (msg.data.error) return { error: msg.data.error.code, env };
    const opened = await openFsEnvelope<FsRpcResult<T>>(keys, msg.data.envelope, { typ: 'res', phone: o.asPhone ?? PHONE, rid: env.rid });
    return { result: opened.payload, env };
  }

  async function rpcOk<T>(payload: unknown): Promise<T> {
    const r = await rpc<T>(payload);
    assert.ok(r.result, `erro ${r.error}`);
    if (!r.result.ok) assert.fail(`${r.result.error.code}: ${r.result.error.message}`);
    return r.result.data;
  }

  it('ida e volta cifrada: roots e list (o rid da resposta é o do pedido)', async () => {
    await writeTree(root.abs, { 'Fotos/a.jpg': 'a' });
    const roots = await rpcOk<{ roots: { id: string }[] }>({ op: 'roots' });
    assert.deepEqual(
      roots.roots.map((r) => r.id),
      [root.id],
    );
    const list = await rpcOk<FsListResponse>({ op: 'list', rootId: root.id, path: 'Fotos' });
    assert.deepEqual(
      list.entries.map((e) => e.name),
      ['a.jpg'],
    );
    const audit = k.audit.entries()[0];
    assert.deepEqual([audit.op, audit.via], ['browse', 'remote']);
  });

  it('falhas ao abrir: chave errada/replay/celular trocado → E2E_FAILED; relógio → CLOCK_SKEW; o PC não cifra resposta', async () => {
    const other = await deriveFsE2eKeys(newPairKey(), PC_ID);
    assert.equal((await rpc({ op: 'roots' }, { keys: other })).error, 'E2E_FAILED');
    assert.equal((await rpc({ op: 'roots' }, { now: Date.now() - 300_000 })).error, 'CLOCK_SKEW');
    const first = await rpc({ op: 'roots' });
    assert.ok(first.result?.ok);
    assert.equal((await rpc(null, { envelope: first.env })).error, 'E2E_FAILED', 'mesmo envelope de novo');
    assert.equal((await rpc({ op: 'roots' }, { phone: 'outro-celular' })).error, 'E2E_FAILED', 'phone do envelope ≠ phoneDeviceId da API');
    assert.equal((await rpc({ op: 'roots' }, { phone: 'intruso', asPhone: 'intruso' })).error, 'E2E_FAILED', 'celular fora da conta');
    // Pedido abriu mas é inválido: a resposta vai cifrada com o erro.
    const bad = await rpc({ op: 'formatar' });
    assert.deepEqual(bad.result && !bad.result.ok && bad.result.error.code, 'UNSUPPORTED_OP');
    // Ops só da LAN não existem no remoto e vice-versa: download pela LAN é rota própria.
    const lanDownload = await k.service.execute({ phoneId: PHONE, via: 'lan' }, { op: 'download', rootId: root.id, path: 'x' });
    assert.equal(!lanDownload.ok && lanDownload.error.code, 'UNSUPPORTED_OP');
  });

  it('idempotência entre vias: mkdir pela LAN e o mesmo requestId pelo remoto devolve a resposta guardada', async () => {
    const requestId = randomFsId();
    const lanRes = await k.service.execute(
      { phoneId: PHONE, via: 'lan' },
      { op: 'mkdir', requestId, rootId: root.id, path: '', name: 'Nova' },
    );
    assert.ok(lanRes.ok);
    await fsp.rm(path.join(root.abs, 'Nova'), { recursive: true });
    const again = await rpcOk<{ created: boolean }>({ op: 'mkdir', requestId, rootId: root.id, path: '', name: 'Nova' });
    assert.equal(again.created, true);
    assert.ok(!existsSync(path.join(root.abs, 'Nova')), 'não executou de novo');
  });

  it('fs.event cifrado para todos os celulares (rootsChanged)', async () => {
    assert.equal(await remote.emitEvent({ kind: 'rootsChanged' }), true);
    const m = sent.find((x) => x.type === 'fs.event');
    assert.ok(m && m.type === 'fs.event');
    assert.equal(m.data.envelope.phone, '*');
    const opened = await openFsEnvelope<FsEvent>(keys, m.data.envelope, { typ: 'evt', phone: '*' });
    assert.deepEqual(opened.payload, { kind: 'rootsChanged' });
  });

  it('download remoto: responde já, cifra em pedaços de 1 MiB, envia em PUTs de 8 MiB com retomada; o celular decifra igual', async () => {
    const content = randomBytes(9 * 1024 * 1024 + 12345);
    await writeTree(root.abs, { 'grande.mp4': content });
    fake.st.puts = [];
    fake.st.failPuts = 1; // a primeira tentativa cai: o PC tenta de novo
    const p = await rpcOk<FsDownloadPrepared>({ op: 'download', rootId: root.id, path: 'grande.mp4' });
    assert.equal(p.size, content.length);
    assert.equal(p.cipherSize, fsBlobCipherSize(content.length));
    assert.equal(p.name, 'grande.mp4');
    assert.equal(p.mime, 'video/mp4');
    assert.match(p.blobSalt, /^[A-Za-z0-9_-]{22}$/);
    await remote.whenIdle();
    const b = fake.st.blobs.get(p.blobId)!;
    assert.equal(b.status, 'ready');
    assert.deepEqual(fake.st.puts.slice(-2), [
      `bytes 0-${8 * 1024 * 1024 - 1}/${p.cipherSize}`,
      `bytes ${8 * 1024 * 1024}-${p.cipherSize - 1}/${p.cipherSize}`,
    ]);
    assert.ok((await phoneOpensBlob(fake.st, keys, p)).equals(content));
    const audit = k.audit.entries().find((e) => e.op === 'download')!;
    assert.deepEqual([audit.via, audit.bytes, audit.path], ['remote', content.length, 'grande.mp4']);
  });

  it('download remoto de arquivo pequeno vai num PUT só; pasta → IS_A_DIRECTORY', async () => {
    await writeTree(root.abs, { 'p.txt': 'pequeno', 'D/': '' });
    fake.st.puts = [];
    const p = await rpcOk<FsDownloadPrepared>({ op: 'download', rootId: root.id, path: 'p.txt' });
    await remote.whenIdle();
    assert.deepEqual(fake.st.puts, ['inteiro']);
    assert.equal((await phoneOpensBlob(fake.st, keys, p)).toString(), 'pequeno');
    const dir = await rpc({ op: 'download', rootId: root.id, path: 'D' });
    assert.equal(dir.result && !dir.result.ok && dir.result.error.code, 'IS_A_DIRECTORY');
  });

  it('download remoto: arquivo muda durante o preparo → fail + fs.event downloadFailed CHANGED', async () => {
    const file = path.join(root.abs, 'muda.txt');
    await writeTree(root.abs, { 'muda.txt': 'versão 1' });
    fake.st.onCreate = async () => {
      await fsp.appendFile(file, ' e mais coisa');
    };
    const p = await rpcOk<FsDownloadPrepared>({ op: 'download', rootId: root.id, path: 'muda.txt' });
    await remote.whenIdle();
    assert.deepEqual(
      fake.st.fails.find((f) => f.id === p.blobId),
      { id: p.blobId, reason: 'changed' },
    );
    const evt = sent.filter((m) => m.type === 'fs.event').pop();
    assert.ok(evt && evt.type === 'fs.event');
    const opened = await openFsEnvelope<FsEvent>(keys, evt.data.envelope, { typ: 'evt', phone: '*' });
    assert.equal(opened.payload.kind, 'downloadFailed');
    assert.equal(opened.payload.kind === 'downloadFailed' && opened.payload.error.code, 'CHANGED');
  });

  it('envio remoto: baixa o blob com retomada, decifra, confere SHA-256, coloca no destino e dá DELETE', async () => {
    const content = randomBytes(3 * FS_BLOB_SEGMENT_BYTES + 777);
    const { blobId, salt } = await phoneUploadsBlob(fake.st, keys, content);
    await writeTree(root.abs, { 'Destino/': '' });
    fake.st.getRanges = [];
    fake.st.dropGetAfter = Math.floor(1.5 * FS_BLOB_SEGMENT_BYTES); // a conexão cai no meio do 2º pedaço
    const requestId = randomFsId();
    const res = await rpcOk<FsUploadStatusResponse>({
      op: 'upload',
      requestId,
      rootId: root.id,
      path: 'Destino',
      name: 'vídeo.bin',
      blobId,
      blobSalt: salt,
      size: content.length,
      sha256: sha256(content),
    });
    assert.equal(res.status, 'done', JSON.stringify(res.error));
    assert.equal(res.result!.path, 'Destino/vídeo.bin');
    assert.equal(res.result!.verifiedHash, sha256(content));
    assert.ok((await fsp.readFile(path.join(root.abs, 'Destino', 'vídeo.bin'))).equals(content));
    // retomou do começo do pedaço 1 (o pedaço 0 já estava inteiro no .part)
    assert.deepEqual(fake.st.getRanges, ['', `bytes=${fsBlobSegment(content.length, 1).cipherStart}-`]);
    assert.ok(fake.st.deleted.includes(blobId));
    assert.ok(!existsSync(path.join(root.abs, '.arkivo-fs-parciais', `blob-${blobId}.part`)));
    const status = await rpcOk<FsUploadStatusResponse>({ op: 'uploadStatus', blobId });
    assert.equal(status.status, 'done');
    // mesmo requestId de novo → mesmo estado, sem baixar de novo
    fake.st.getRanges = [];
    const again = await rpcOk<FsUploadStatusResponse>({
      op: 'upload',
      requestId,
      rootId: root.id,
      path: 'Destino',
      name: 'vídeo.bin',
      blobId,
      blobSalt: salt,
      size: content.length,
      sha256: sha256(content),
    });
    assert.equal(again.status, 'done');
    assert.deepEqual(fake.st.getRanges, []);
    const audit = k.audit.entries().find((e) => e.op === 'upload')!;
    assert.deepEqual([audit.via, audit.bytes, audit.path, audit.result], ['remote', content.length, 'Destino/vídeo.bin', 'ok']);
  });

  it('envio remoto: SHA-256 diferente → failed HASH_MISMATCH (nada no destino); conflito com fail → CONFLICT antes de baixar', async () => {
    const content = Buffer.from('conteúdo verdadeiro');
    const { blobId, salt } = await phoneUploadsBlob(fake.st, keys, content);
    const r = await rpcOk<FsUploadStatusResponse>({
      op: 'upload',
      requestId: randomFsId(),
      rootId: root.id,
      path: '',
      name: 'x.txt',
      blobId,
      blobSalt: salt,
      size: content.length,
      sha256: sha256('outra coisa'),
    });
    assert.equal(r.status, 'failed');
    assert.equal(r.error!.code, 'HASH_MISMATCH');
    assert.ok(!existsSync(path.join(root.abs, 'x.txt')));
    await writeTree(root.abs, { 'existe.txt': 'já estava' });
    const second = await phoneUploadsBlob(fake.st, keys, content);
    fake.st.getRanges = [];
    const c = await rpc({
      op: 'upload',
      requestId: randomFsId(),
      rootId: root.id,
      path: '',
      name: 'existe.txt',
      onConflict: 'fail',
      blobId: second.blobId,
      blobSalt: second.salt,
      size: content.length,
      sha256: sha256(content),
    });
    assert.equal(c.result && !c.result.ok && c.result.error.code, 'CONFLICT');
    assert.deepEqual(fake.st.getRanges, [], 'não baixou nada');
  });

  it('envio remoto demorado: responde pending, avisa por fs.event uploadDone e uploadStatus responde done', async () => {
    commitWaitMs = 30;
    fake.st.getDelayMs = 200;
    const content = randomBytes(5000);
    const { blobId, salt } = await phoneUploadsBlob(fake.st, keys, content);
    const r = await rpcOk<FsUploadStatusResponse>({
      op: 'upload',
      requestId: randomFsId(),
      rootId: root.id,
      path: '',
      name: 'lento.bin',
      blobId,
      blobSalt: salt,
      size: content.length,
      sha256: sha256(content),
    });
    assert.equal(r.status, 'pending');
    await remote.whenIdle();
    await waitFor(() => sent.some((m) => m.type === 'fs.event'));
    const evt = sent.filter((m) => m.type === 'fs.event').pop();
    assert.ok(evt && evt.type === 'fs.event');
    const opened = await openFsEnvelope<FsEvent>(keys, evt.data.envelope, { typ: 'evt', phone: '*' });
    assert.equal(opened.payload.kind, 'uploadDone');
    assert.equal(opened.payload.kind === 'uploadDone' && opened.payload.result.path, 'lento.bin');
    const status = await rpcOk<FsUploadStatusResponse>({ op: 'uploadStatus', blobId });
    assert.equal(status.status, 'done');
    // O estado sobrevive a reiniciar o PC (fs-uploads.json).
    const reloaded = new FsRemote({
      service: k.service,
      api: new ApiClient({ baseUrl: fake.api.url, getDeviceToken: () => 'tok' }),
      send: () => true,
      getCreds: () => null,
      dataDir: k.dataDir,
    });
    await waitFor(async () => existsSync(path.join(k.dataDir, 'fs-uploads.json')));
    await new Promise((r) => setTimeout(r, 50));
    await reloaded.load();
    assert.equal((await reloaded.uploadStatus({ phoneId: PHONE, via: 'remote' }, { op: 'uploadStatus', blobId })).status, 'done');
    k.service.remote = remote;
  });
});
