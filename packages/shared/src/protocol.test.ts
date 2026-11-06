// Testes do versionamento compartilhado (contrato §9).
// Rodam com: npx tsx --test packages/shared/src/*.test.ts (e também pelo `npm run test:integration`).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  checkClientCompat,
  clientHeaders,
  clientQuery,
  compareSemver,
  formatClientHeader,
  formatUpgradeCloseReason,
  isProtocolSupported,
  isSemver,
  isVersionAtLeast,
  parseClientHeader,
  parseProtocolHeader,
  parseSemver,
  parseUpgradeCloseReason,
  parseUpgradeRequired,
  peerProtocol,
  upgradeRequiredBody,
} from './protocol';

describe('semver', () => {
  test('lê versões válidas', () => {
    assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(parseSemver('0.1.0-beta.2'), { major: 0, minor: 1, patch: 0, prerelease: ['beta', '2'] });
    assert.deepEqual(parseSemver('10.20.30+build.7'), { major: 10, minor: 20, patch: 30, prerelease: [] });
  });

  test('recusa versões malformadas', () => {
    for (const v of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3-', '1.2.3-01', 'a.b.c', '1.2.x', ' ', '1.2.3 beta', '9'.repeat(70) + '.0.0'])
      assert.equal(isSemver(v), false, JSON.stringify(v));
  });

  test('compara pela precedência do semver.org', () => {
    const ordered = ['0.0.1', '0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '0.10.0', '1.0.0', '2.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const expected = i < j ? -1 : i > j ? 1 : 0;
        assert.equal(compareSemver(ordered[i], ordered[j]), expected, `${ordered[i]} vs ${ordered[j]}`);
      }
    }
  });

  test('build metadata não conta na comparação', () => {
    assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
  });

  test('isVersionAtLeast: abaixo, igual e acima do mínimo', () => {
    assert.equal(isVersionAtLeast('0.0.9', '0.1.0'), false);
    assert.equal(isVersionAtLeast('0.1.0', '0.1.0'), true);
    assert.equal(isVersionAtLeast('0.1.1', '0.1.0'), true);
    assert.equal(isVersionAtLeast('0.1.0-beta', '0.1.0'), false);
  });

  test('compareSemver lança erro em versão inválida', () => {
    assert.throws(() => compareSemver('1.0', '1.0.0'), /Versão inválida/);
  });
});

describe('cabeçalhos X-Arkivo-Client e X-Arkivo-Protocol', () => {
  test('monta e interpreta X-Arkivo-Client', () => {
    assert.equal(formatClientHeader('pc', '0.1.0'), 'pc/0.1.0');
    assert.equal(formatClientHeader('mobile', '1.2.3-rc.1'), 'mobile/1.2.3-rc.1');
    assert.deepEqual(parseClientHeader('pc/0.1.0'), { kind: 'pc', version: '0.1.0' });
    assert.deepEqual(parseClientHeader(' MOBILE/2.0.0 '), { kind: 'mobile', version: '2.0.0' });
    assert.throws(() => formatClientHeader('pc', '0.1'), /Versão inválida/);
  });

  test('X-Arkivo-Client malformado vira null', () => {
    for (const v of ['', 'pc', 'pc/', '/0.1.0', 'web/0.1.0', 'pc/0.1', 'pc/v0.1.0', 'pc 0.1.0', 'pc/0.1.0/x'])
      assert.equal(parseClientHeader(v), null, JSON.stringify(v));
  });

  test('X-Arkivo-Protocol: inteiro positivo', () => {
    assert.equal(parseProtocolHeader('1'), 1);
    assert.equal(parseProtocolHeader(' 12 '), 12);
    for (const v of ['', '0', '-1', '1.0', 'abc', '01', '1e3', '9999999']) assert.equal(parseProtocolHeader(v), null, v);
  });

  test('clientHeaders e clientQuery levam o protocolo desta build', () => {
    assert.deepEqual(clientHeaders('pc', '0.1.0'), { 'X-Arkivo-Client': 'pc/0.1.0', 'X-Arkivo-Protocol': String(PROTOCOL_VERSION) });
    assert.deepEqual(clientQuery('mobile', '0.1.0'), { client: 'mobile/0.1.0', protocol: String(PROTOCOL_VERSION) });
  });

  test('faixa de protocolo e protocolo de um par', () => {
    assert.equal(isProtocolSupported(PROTOCOL_VERSION), true);
    assert.equal(isProtocolSupported(PROTOCOL_VERSION + 1), false);
    assert.equal(isProtocolSupported(0), false);
    assert.equal(isProtocolSupported(2, { min: 1, max: 3 }), true);
    assert.equal(peerProtocol(undefined), 1, 'ausente = protocolo legado 1');
    assert.equal(peerProtocol(3), 3);
    assert.equal(peerProtocol('1'), null);
    assert.equal(peerProtocol(1.5), null);
  });
});

describe('checkClientCompat (regra única de aceitação)', () => {
  const policy = { minVersions: { pc: '0.2.0', mobile: '0.1.0' }, protocols: { min: 1, max: 1 }, serverProtocol: 1 };

  test('sem cabeçalho → aceita e marca missing', () => {
    assert.deepEqual(checkClientCompat({}, policy), { status: 'ok', client: null, protocol: null, missing: true });
    assert.deepEqual(checkClientCompat({ client: '  ', protocol: '' }, policy), { status: 'ok', client: null, protocol: null, missing: true });
  });

  test('versão abaixo do mínimo → upgrade com minVersion do tipo', () => {
    const r = checkClientCompat({ client: 'pc/0.1.9', protocol: '1' }, policy);
    assert.equal(r.status, 'upgrade');
    if (r.status === 'upgrade') {
      assert.equal(r.reason, 'version');
      assert.deepEqual(r.info, { minVersion: '0.2.0', kind: 'pc', protocol: 1 });
    }
  });

  test('igual e acima do mínimo → ok', () => {
    assert.equal(checkClientCompat({ client: 'pc/0.2.0', protocol: '1' }, policy).status, 'ok');
    assert.equal(checkClientCompat({ client: 'pc/3.0.0' }, policy).status, 'ok');
  });

  test('protocolo fora da faixa → upgrade (reason protocol), mesmo com versão nova', () => {
    const r = checkClientCompat({ client: 'mobile/9.0.0', protocol: '2' }, policy);
    assert.equal(r.status, 'upgrade');
    if (r.status === 'upgrade') {
      assert.equal(r.reason, 'protocol');
      assert.deepEqual(r.info, { minVersion: '0.1.0', kind: 'mobile', protocol: 1 });
    }
    const anon = checkClientCompat({ protocol: '7' }, policy);
    assert.ok(anon.status === 'upgrade' && anon.info.kind === null && anon.info.minVersion === null);
  });

  test('cabeçalho malformado → invalid, apontando qual', () => {
    const a = checkClientCompat({ client: 'pc/abc' }, policy);
    assert.ok(a.status === 'invalid' && a.header === 'X-Arkivo-Client');
    const b = checkClientCompat({ client: 'pc/0.2.0', protocol: 'um' }, policy);
    assert.ok(b.status === 'invalid' && b.header === 'X-Arkivo-Protocol');
  });

  test('tipo sem mínimo configurado aceita qualquer versão', () => {
    assert.equal(checkClientCompat({ client: 'mobile/0.0.1' }, { minVersions: { pc: '1.0.0' } }).status, 'ok');
  });
});

describe('corpo do 426 e reason do WebSocket', () => {
  test('upgradeRequiredBody segue o formato de erro da API e volta pelo parser', () => {
    const body = upgradeRequiredBody({ minVersion: '0.2.0', kind: 'pc', protocol: 1 });
    assert.equal(body.error.code, 'UPGRADE_REQUIRED');
    assert.match(body.error.message, /Arkivo para PC/);
    assert.match(body.error.message, /0\.2\.0/);
    assert.deepEqual(parseUpgradeRequired(JSON.parse(JSON.stringify(body))), { minVersion: '0.2.0', kind: 'pc', protocol: 1 });
    assert.equal(parseUpgradeRequired({ error: { code: 'CONFLICT', message: 'x' } }), null);
    assert.equal(parseUpgradeRequired('nada'), null);
  });

  test('reason do fechamento 4426 cabe no frame e é tolerante a lixo', () => {
    const reason = formatUpgradeCloseReason({ minVersion: '10.20.30-beta.1', kind: 'mobile', protocol: 12 });
    assert.ok(Buffer.byteLength(reason) <= 123);
    assert.deepEqual(parseUpgradeCloseReason(reason), { minVersion: '10.20.30-beta.1', kind: 'mobile', protocol: 12 });
    assert.deepEqual(parseUpgradeCloseReason('upgrade required'), { minVersion: null, kind: null, protocol: PROTOCOL_VERSION });
  });
});
