import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lanSignaturePayload } from '@arkivo/shared';
import { createHmac } from 'node:crypto';
import { signLanRequest, verifyLanRequest } from './lan-auth';
import { newPairKey, sha256, signedHeaders } from './test-helpers';

const pairKey = newPairKey();
const ctx = { pairKey, allowedPhones: new Set(['phoneA']) };
const hash = sha256('conteudo');
const path = '/v1/files/abc123';
const now = 1_780_000_000_000;

function lower(h: Record<string, string>) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

describe('verificação HMAC da LAN', () => {
  it('assinatura bate com o texto canônico do contrato', () => {
    const ts = String(now);
    const expected = createHmac('sha256', Buffer.from(pairKey, 'base64'))
      .update(lanSignaturePayload('PUT', path, ts, hash))
      .digest('base64');
    assert.equal(signLanRequest(pairKey, 'put', path, ts, hash), expected);
  });

  it('aceita requisição válida (PUT com hash)', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    const r = verifyLanRequest({ method: 'PUT', path, headers, now }, ctx);
    assert.deepEqual(r, { ok: true, phoneId: 'phoneA' });
  });

  it('aceita HEAD sem hash (texto termina vazio)', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'HEAD', path, ts: now }));
    assert.equal(verifyLanRequest({ method: 'HEAD', path, headers, now }, ctx).ok, true);
  });

  it('recusa assinatura errada', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    const sig = Buffer.from(headers['x-arkivo-sig'], 'base64');
    sig[0] ^= 0xff;
    headers['x-arkivo-sig'] = sig.toString('base64');
    const r = verifyLanRequest({ method: 'PUT', path, headers, now }, ctx);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 401);
  });

  it('recusa assinatura de tamanho diferente sem lançar', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    headers['x-arkivo-sig'] = 'AAAA';
    assert.equal(verifyLanRequest({ method: 'PUT', path, headers, now }, ctx).ok, false);
  });

  it('recusa se o hash do cabeçalho foi trocado (hash faz parte da assinatura)', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    headers['x-arkivo-hash'] = sha256('outro');
    assert.equal(verifyLanRequest({ method: 'PUT', path, headers, now }, ctx).ok, false);
  });

  it('recusa caminho ou método diferentes do assinado', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    assert.equal(verifyLanRequest({ method: 'PUT', path: '/v1/files/outro', headers, now }, ctx).ok, false);
    assert.equal(verifyLanRequest({ method: 'HEAD', path, headers, now }, ctx).ok, false);
  });

  it('recusa timestamp fora da janela de 120 s (para frente e para trás)', () => {
    for (const skew of [120_001, -120_001, 10 * 60_000]) {
      const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now + skew }));
      const r = verifyLanRequest({ method: 'PUT', path, headers, now }, ctx);
      assert.equal(r.ok, false, `skew ${skew}`);
    }
    const ok = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now - 119_000 }));
    assert.equal(verifyLanRequest({ method: 'PUT', path, headers: ok, now }, ctx).ok, true);
  });

  it('recusa celular de outro usuário (outra pairKey) com 401', () => {
    const headers = lower(signedHeaders({ pairKey: newPairKey(), phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    const r = verifyLanRequest({ method: 'PUT', path, headers, now }, ctx);
    assert.equal(!r.ok && r.status, 401);
  });

  it('recusa celular fora da lista de peers com 403, mesmo com assinatura válida', () => {
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneDeOutro', method: 'PUT', path, hash, ts: now }));
    const r = verifyLanRequest({ method: 'PUT', path, headers, now }, ctx);
    assert.equal(!r.ok && r.status, 403);
  });

  it('recusa sem cabeçalhos ou sem pareamento', () => {
    assert.equal(verifyLanRequest({ method: 'PUT', path, headers: {}, now }, ctx).ok, false);
    const headers = lower(signedHeaders({ pairKey, phoneId: 'phoneA', method: 'PUT', path, hash, ts: now }));
    assert.equal(verifyLanRequest({ method: 'PUT', path, headers, now }, null).ok, false);
  });
});
