// Testes do envelope E2E, dos blobs cifrados e da assinatura LAN das rotas /v1/fs/* (contrato §10.5–§10.7).
// Conferem também a interoperabilidade com `node:crypto` (o PC e a API podem usar a implementação do Node).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  FsE2eError,
  FsReplayGuard,
  deriveFsE2eKeys,
  fsBlobCipherSize,
  fsBlobPlainSize,
  fsBlobSegment,
  fsBlobSegmentAad,
  fsBlobSegmentCount,
  fsEnvelopeAad,
  hmacSha256Base64,
  newFsBlobSalt,
  openFsEnvelope,
  parseFsEnvelope,
  randomFsId,
  sealFsEnvelope,
  sha256Hex,
  signLanFsRequest,
  verifyHmacSha256Base64,
  FS_E2E_LABELS,
  type FsEnvelope,
} from './e2e';
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from './encoding';
import { FS_BLOB_SEGMENT_BYTES, FS_E2E_MAX_SKEW_MS, lanFsSignaturePayload } from './fs';

const pairKey = bytesToBase64(new Uint8Array(32).map((_, i) => i + 1));
const PC = '6650f0c1a2b3c4d5e6f70809';
const PHONE = '6650f0c1a2b3c4d5e6f7080a';
const NOW = 1_780_000_000_000;

async function rejectsCode(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof FsE2eError && e.code === code);
}

describe('codificação', () => {
  test('base64/base64url ida e volta', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(nodeRandomBytes(n));
      assert.equal(bytesToBase64(b), Buffer.from(b).toString('base64'));
      assert.equal(bytesToBase64Url(b), Buffer.from(b).toString('base64url'));
      assert.deepEqual(base64ToBytes(bytesToBase64Url(b)), b);
    }
    assert.throws(() => base64ToBytes('a$b='));
    assert.equal(randomFsId().length, 22);
  });

  test('sha256Hex igual ao node:crypto', async () => {
    assert.equal(await sha256Hex('arkivo'), createHash('sha256').update('arkivo').digest('hex'));
  });
});

describe('envelope E2E', () => {
  test('ida e volta: pedido e resposta', async () => {
    const pcKeys = await deriveFsE2eKeys(pairKey, PC);
    const phoneKeys = await deriveFsE2eKeys(pairKey, PC);
    const req = await sealFsEnvelope(phoneKeys, { phone: PHONE, typ: 'req', now: NOW }, { op: 'list', rootId: 'r_abcdefgh', path: 'Férias' });
    assert.equal(req.v, 1);
    assert.equal(req.pc, PC);
    assert.equal(JSON.stringify(req).includes('Férias'), false);
    assert.equal(JSON.stringify(req).includes('list'), false);

    const guard = new FsReplayGuard();
    const opened = await openFsEnvelope<{ path: string }>(pcKeys, JSON.parse(JSON.stringify(req)), {
      typ: 'req',
      allowedPhones: new Set([PHONE]),
      now: NOW + 1000,
      replay: guard,
    });
    assert.equal(opened.payload.path, 'Férias');

    const res = await sealFsEnvelope(pcKeys, { phone: PHONE, typ: 'res', rid: req.rid, now: NOW + 2000 }, { ok: true, data: { n: 1 } });
    const back = await openFsEnvelope(phoneKeys, res, { typ: 'res', phone: PHONE, rid: req.rid, now: NOW + 2500 });
    assert.deepEqual(back.payload, { ok: true, data: { n: 1 } });
  });

  test('interopera com node:crypto (HKDF + AES-256-GCM)', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const env = await sealFsEnvelope(keys, { phone: PHONE, typ: 'req', now: NOW }, { op: 'roots' });
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(pairKey, 'base64'), FS_E2E_LABELS.salt, FS_E2E_LABELS.rpcInfo(PC), 32));
    const ct = Buffer.from(env.ct, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.n, 'base64url'));
    d.setAAD(Buffer.from(fsEnvelopeAad(env), 'utf8'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
    assert.equal(plain, '{"op":"roots"}');
  });

  test('adulteração do texto cifrado, do nonce ou do cabeçalho → DECRYPT_FAILED', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const env = await sealFsEnvelope(keys, { phone: PHONE, typ: 'req', now: NOW }, { op: 'roots' });
    const flip = (s: string) => {
      const b = base64ToBytes(s);
      b[0] ^= 1;
      return bytesToBase64Url(b);
    };
    const expect = { typ: 'req' as const, now: NOW };
    await rejectsCode(openFsEnvelope(keys, { ...env, ct: flip(env.ct) }, expect), 'DECRYPT_FAILED');
    await rejectsCode(openFsEnvelope(keys, { ...env, n: flip(env.n) }, expect), 'DECRYPT_FAILED');
    // AAD errada: outro celular, outro rid, outro horário (dentro da janela).
    await rejectsCode(openFsEnvelope(keys, { ...env, phone: 'outrocelular1' }, expect), 'DECRYPT_FAILED');
    await rejectsCode(openFsEnvelope(keys, { ...env, rid: randomFsId() }, expect), 'DECRYPT_FAILED');
    await rejectsCode(openFsEnvelope(keys, { ...env, ts: env.ts + 1 }, expect), 'DECRYPT_FAILED');
  });

  test('chave errada (outro pairKey) ou outro PC', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const env = await sealFsEnvelope(keys, { phone: PHONE, typ: 'req', now: NOW }, { op: 'roots' });
    const other = await deriveFsE2eKeys(bytesToBase64(new Uint8Array(32).fill(9)), PC);
    await rejectsCode(openFsEnvelope(other, env, { typ: 'req', now: NOW }), 'DECRYPT_FAILED');
    const otherPc = await deriveFsE2eKeys(pairKey, 'outroPc00000000000000001');
    await rejectsCode(openFsEnvelope(otherPc, env, { typ: 'req', now: NOW }), 'WRONG_CONTEXT');
    // Mesmo trocando o campo `pc`, a chave do outro PC é outra (info do HKDF inclui o pcDeviceId).
    await rejectsCode(openFsEnvelope(otherPc, { ...env, pc: otherPc.pcDeviceId }, { typ: 'req', now: NOW }), 'DECRYPT_FAILED');
  });

  test('contexto: tipo, celular fora da conta, rid da resposta', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const req = await sealFsEnvelope(keys, { phone: PHONE, typ: 'req', now: NOW }, {});
    // Uma resposta refletida como pedido (ou o contrário) não abre.
    await rejectsCode(openFsEnvelope(keys, req, { typ: 'res', now: NOW }), 'WRONG_CONTEXT');
    await rejectsCode(openFsEnvelope(keys, req, { typ: 'req', allowedPhones: new Set(['outro']), now: NOW }), 'WRONG_CONTEXT');
    const res = await sealFsEnvelope(keys, { phone: PHONE, typ: 'res', rid: req.rid, now: NOW }, {});
    await rejectsCode(openFsEnvelope(keys, res, { typ: 'res', phone: PHONE, rid: randomFsId(), now: NOW }), 'WRONG_CONTEXT');
    await rejectsCode(openFsEnvelope(keys, res, { typ: 'res', phone: 'outro', now: NOW }), 'WRONG_CONTEXT');
  });

  test('expirado (fora da janela) e replay', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const env = await sealFsEnvelope(keys, { phone: PHONE, typ: 'req', now: NOW }, { op: 'roots' });
    await rejectsCode(openFsEnvelope(keys, env, { typ: 'req', now: NOW + FS_E2E_MAX_SKEW_MS + 1 }), 'EXPIRED');
    await rejectsCode(openFsEnvelope(keys, env, { typ: 'req', now: NOW - FS_E2E_MAX_SKEW_MS - 1 }), 'EXPIRED');
    const guard = new FsReplayGuard();
    await openFsEnvelope(keys, env, { typ: 'req', now: NOW, replay: guard });
    await rejectsCode(openFsEnvelope(keys, env, { typ: 'req', now: NOW + 10, replay: guard }), 'REPLAYED');
    // Um envelope forjado (não decifra) não "queima" o rid de um pedido legítimo.
    const legit = await sealFsEnvelope(keys, { phone: PHONE, typ: 'req', now: NOW }, { op: 'roots' });
    const forged: FsEnvelope = { ...legit, ct: bytesToBase64Url(new Uint8Array(40)) };
    await rejectsCode(openFsEnvelope(keys, forged, { typ: 'req', now: NOW, replay: guard }), 'DECRYPT_FAILED');
    await openFsEnvelope(keys, legit, { typ: 'req', now: NOW, replay: guard });
  });

  test('replay guard esquece depois da janela', () => {
    const g = new FsReplayGuard(1000);
    assert.equal(g.accept('a', 0, 0), true);
    assert.equal(g.accept('a', 0, 500), false);
    assert.equal(g.accept('a', 0, 1501), true);
    assert.equal(new FsReplayGuard(1000, 1).accept('x', 0, 0), true);
  });

  test('forma do envelope e limites', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const env = await sealFsEnvelope(keys, { phone: PHONE, typ: 'evt', now: NOW }, { kind: 'rootsChanged' });
    assert.deepEqual(parseFsEnvelope(JSON.stringify(env)), env);
    assert.equal(parseFsEnvelope({ ...env, v: 2 }), null);
    assert.equal(parseFsEnvelope({ ...env, typ: 'xyz' }), null);
    assert.equal(parseFsEnvelope({ ...env, n: 'curto' }), null);
    assert.equal(parseFsEnvelope({ ...env, ts: 1.5 }), null);
    assert.equal(parseFsEnvelope('{nao json'), null);
    assert.equal(parseFsEnvelope({ ...env, ct: env.ct + '!' }), null);
    await rejectsCode(sealFsEnvelope(keys, { phone: PHONE, typ: 'res', maxPlaintextBytes: 10 }, { grande: 'x'.repeat(20) }), 'TOO_LARGE');
    await assert.rejects(deriveFsE2eKeys(bytesToBase64(new Uint8Array(16)), PC), (e: unknown) => e instanceof FsE2eError && e.code === 'BAD_KEY');
  });
});

describe('blob cifrado em pedaços', () => {
  test('tamanhos', () => {
    const S = FS_BLOB_SEGMENT_BYTES;
    for (const plain of [0, 1, S - 1, S, S + 1, 3 * S, 3 * S + 17]) {
      const c = fsBlobCipherSize(plain);
      assert.equal(c, plain + fsBlobSegmentCount(plain) * 16, String(plain));
      assert.equal(fsBlobPlainSize(c), plain, String(plain));
    }
    assert.equal(fsBlobSegmentCount(0), 1);
    assert.equal(fsBlobPlainSize(15), null);
    assert.equal(fsBlobPlainSize(S + 16 + 10), null); // sobra de 10 bytes não cabe a tag
    const last = fsBlobSegment(2 * S + 5, 2);
    assert.deepEqual(last, { index: 2, plainStart: 2 * S, plainLength: 5, cipherStart: 2 * (S + 16), cipherLength: 21, last: true });
    assert.throws(() => fsBlobSegment(10, 1), RangeError);
  });

  test('ida e volta, cifra determinística e interoperável com node:crypto', async () => {
    const S = FS_BLOB_SEGMENT_BYTES;
    const plain = new Uint8Array(nodeRandomBytes(S + 1000));
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const salt = newFsBlobSalt();
    const blobId = '6650f0c1a2b3c4d5e6f7aaaa';
    const k = await keys.blobKey(blobId, salt, plain.length);
    assert.equal(k.segmentCount, 2);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < k.segmentCount; i++) {
      const seg = fsBlobSegment(plain.length, i);
      parts.push(await k.sealSegment(i, plain.subarray(seg.plainStart, seg.plainStart + seg.plainLength)));
    }
    assert.equal(parts[0].length + parts[1].length, k.cipherSize);
    // Determinística: cifrar de novo dá os mesmos bytes (permite calcular o SHA-256 antes de enviar e retomar).
    const again = await k.sealSegment(1, plain.subarray(S));
    assert.deepEqual(again, parts[1]);
    // Abre com outra instância (outro lado).
    const k2 = await (await deriveFsE2eKeys(pairKey, PC)).blobKey(blobId, salt, plain.length);
    assert.deepEqual(await k2.openSegment(0, parts[0]), plain.subarray(0, S));
    assert.deepEqual(await k2.openSegment(1, parts[1]), plain.subarray(S));
    // node:crypto: chave HKDF(sal do blob, info com pc e blob), nonce = 4 zeros + índice BE.
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(pairKey, 'base64'), Buffer.from(salt, 'base64url'), FS_E2E_LABELS.blobInfo(PC, blobId), 32));
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(1n, 4);
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(Buffer.from(fsBlobSegmentAad(blobId, 1, true, plain.length)));
    d.setAuthTag(Buffer.from(parts[1].subarray(parts[1].length - 16)));
    assert.deepEqual(new Uint8Array(Buffer.concat([d.update(parts[1].subarray(0, parts[1].length - 16)), d.final()])), plain.subarray(S));
  });

  test('pedaço trocado de lugar, truncado, de outro blob ou adulterado não abre', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const salt = newFsBlobSalt();
    const S = FS_BLOB_SEGMENT_BYTES;
    const size = 2 * S;
    const k = await keys.blobKey('blobAAAAAAAA', salt, size);
    const p0 = await k.sealSegment(0, new Uint8Array(S).fill(1));
    const p1 = await k.sealSegment(1, new Uint8Array(S).fill(2));
    await rejectsCode(k.openSegment(1, p0), 'DECRYPT_FAILED');
    // Arquivo cortado no limite de um pedaço: o tamanho total entra na AAD, então o pedaço 0 não vale num blob de 1 pedaço.
    const truncated = await keys.blobKey('blobAAAAAAAA', salt, S);
    await rejectsCode(truncated.openSegment(0, p0), 'DECRYPT_FAILED');
    const other = await keys.blobKey('blobBBBBBBBB', salt, size);
    await rejectsCode(other.openSegment(0, p0), 'DECRYPT_FAILED');
    const bad = new Uint8Array(p1);
    bad[100] ^= 0xff;
    await rejectsCode(k.openSegment(1, bad), 'DECRYPT_FAILED');
    await rejectsCode(k.openSegment(1, p1.subarray(1)), 'DECRYPT_FAILED');
    await assert.rejects(k.sealSegment(0, new Uint8Array(3)), FsE2eError);
    await assert.rejects(keys.blobKey('x', 'curto', 1), FsE2eError);
  });

  test('arquivo vazio', async () => {
    const keys = await deriveFsE2eKeys(pairKey, PC);
    const k = await keys.blobKey('vazio0000000', newFsBlobSalt(), 0);
    const c = await k.sealSegment(0, new Uint8Array(0));
    assert.equal(c.length, 16);
    assert.equal((await k.openSegment(0, c)).length, 0);
  });
});

describe('assinatura LAN das rotas /v1/fs/*', () => {
  test('cabeçalhos e HMAC iguais ao node:crypto; verificação em tempo constante', async () => {
    const h = await signLanFsRequest({
      method: 'GET',
      path: '/v1/fs/list',
      query: 'path=Fotos&rootId=r_abcdefgh',
      pairKey,
      phoneDeviceId: PHONE,
      now: NOW,
      nonce: 'n'.repeat(22),
    });
    assert.equal(h['x-arkivo-device'], PHONE);
    assert.equal(h['x-arkivo-ts'], String(NOW));
    assert.equal(h['x-arkivo-nonce'], 'n'.repeat(22));
    const payload = lanFsSignaturePayload({ method: 'GET', path: '/v1/fs/list', query: 'path=Fotos&rootId=r_abcdefgh', ts: NOW, nonce: 'n'.repeat(22) });
    const expected = createHmac('sha256', Buffer.from(pairKey, 'base64')).update(payload).digest('base64');
    assert.equal(h['x-arkivo-sig'], expected);
    assert.equal(await hmacSha256Base64(pairKey, payload), expected);
    assert.equal(await verifyHmacSha256Base64(pairKey, payload, expected), true);
    assert.equal(await verifyHmacSha256Base64(pairKey, payload + 'x', expected), false);
    assert.equal(await verifyHmacSha256Base64(pairKey, payload, 'curta'), false);
    assert.equal(await verifyHmacSha256Base64(pairKey, payload, '***'), false);
  });

  test('nonce aleatório por padrão', async () => {
    const a = await signLanFsRequest({ method: 'GET', path: '/v1/fs/roots', query: '', pairKey, phoneDeviceId: PHONE });
    const b = await signLanFsRequest({ method: 'GET', path: '/v1/fs/roots', query: '', pairKey, phoneDeviceId: PHONE });
    assert.notEqual(a['x-arkivo-nonce'], b['x-arkivo-nonce']);
    assert.match(a['x-arkivo-nonce'], /^[A-Za-z0-9_-]{22}$/);
  });
});
