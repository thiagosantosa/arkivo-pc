import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ActivityLog } from './activity-log';
import { ConfigStore } from './config-store';
import { tempDir } from './test-helpers';
import { SecretCipher } from './types';

const fakeCipher = (available = true): SecretCipher => ({
  scheme: 'fake',
  isAvailable: () => available,
  encrypt: (s) => Buffer.from(s.split('').reverse().join('')).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString().split('').reverse().join(''),
});

const creds = { deviceId: 'pc1', deviceToken: 'SEGREDO-TOKEN', pairKey: 'SEGREDO-PAIRKEY', account: { name: 'Thiago', handle: 'thiago' } };

describe('config-store', () => {
  it('grava deviceToken e pairKey cifrados e recupera após reiniciar', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const a = new ConfigStore({ dir, cipher: fakeCipher(), defaults: { apiBaseUrl: 'http://api', pcName: 'PC' } });
      await a.load();
      assert.equal(a.settings.autostart, true);
      assert.equal(a.settings.lanPort, 47800);
      assert.equal(a.getCredentials(), null);
      await a.setCredentials(creds);
      await a.update({ storageDir: '/x/Arkivo' });
      const raw = await fsp.readFile(path.join(dir, 'config.json'), 'utf8');
      assert.ok(!raw.includes('SEGREDO'), 'segredos não aparecem em texto puro');
      assert.match(raw, /"scheme": "fake"/);

      const b = new ConfigStore({ dir, cipher: fakeCipher(), defaults: { apiBaseUrl: 'http://api', pcName: 'PC' } });
      await b.load();
      assert.deepEqual(b.getCredentials(), creds);
      assert.equal(b.settings.storageDir, '/x/Arkivo');
      assert.equal(b.secretsProtected, true);

      await b.clearCredentials();
      const c = new ConfigStore({ dir, cipher: fakeCipher(), defaults: { apiBaseUrl: 'http://api', pcName: 'PC' } });
      await c.load();
      assert.equal(c.getCredentials(), null);
      assert.equal(c.settings.storageDir, '/x/Arkivo', 'pasta continua configurada');
    } finally {
      await cleanup();
    }
  });

  it('sem cofre do SO grava como "plain" e ainda funciona', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const a = new ConfigStore({ dir, cipher: fakeCipher(false), defaults: { apiBaseUrl: 'http://api', pcName: 'PC' } });
      await a.load();
      await a.setCredentials(creds);
      assert.equal(a.secretsProtected, false);
      const b = new ConfigStore({ dir, cipher: fakeCipher(false), defaults: { apiBaseUrl: 'http://api', pcName: 'PC' } });
      await b.load();
      assert.deepEqual(b.getCredentials(), creds);
    } finally {
      await cleanup();
    }
  });

  it('JSON corrompido não derruba o app (volta ao padrão)', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fsp.writeFile(path.join(dir, 'config.json'), '{quebrado');
      const a = new ConfigStore({ dir, cipher: fakeCipher(), defaults: { apiBaseUrl: 'http://api', pcName: 'PC' } });
      await a.load();
      assert.equal(a.settings.storageDir, null);
    } finally {
      await cleanup();
    }
  });
});

describe('activity-log', () => {
  it('guarda só os últimos 200, conta por mês sem duplicatas e persiste', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const log = new ActivityLog(dir);
      await log.load();
      for (let i = 0; i < 205; i++) {
        await log.add({
          fileId: `f${i}`,
          name: `IMG_${i}.jpg`,
          relativePath: i % 2 ? `2026/11/IMG_${i}.jpg` : `2026/10/IMG_${i}.jpg`,
          size: 1000,
          hash: 'a'.repeat(64),
          route: 'lan',
          status: 'saved',
          durationMs: 100,
          bytesTransferred: 1000,
        });
      }
      await log.add({ fileId: 'dup', name: 'IMG_1.jpg', relativePath: '2026/11/IMG_1.jpg', size: 1000, hash: 'a'.repeat(64), route: 'relay', status: 'saved', duplicate: true });
      await log.add({ fileId: 'err', name: 'x.jpg', relativePath: null, size: 0, hash: null, route: 'relay', status: 'failed', error: 'SHA-256 não confere' });
      assert.equal(log.entries().length, 200);
      assert.equal(log.entries()[0].fileId, 'err');
      assert.deepEqual(log.monthCounts(), [
        { month: '2026-11', count: 102 },
        { month: '2026-10', count: 103 },
      ]);
      assert.equal(log.totalSaved, 205);
      assert.equal(log.averageSpeed('lan'), 10_000);

      const again = new ActivityLog(dir);
      await again.load();
      assert.equal(again.entries().length, 200);
      assert.equal(again.totalSaved, 205);
    } finally {
      await cleanup();
    }
  });
});
