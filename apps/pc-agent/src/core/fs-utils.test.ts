import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { DiskError, fsyncDir, isNoSpace, mkdirDurable, writeFileAtomic, writeStreamDurable } from './fs-utils';
import { assertOrder, errno, isMark, isOp, spyFs, tempDir } from './test-helpers';
import type { Logger } from './types';

function recordingLogger() {
  const warns: string[] = [];
  const logger: Logger = { info() {}, warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')), error() {} };
  return { warns, logger };
}

describe('fsyncDir', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  before(async () => {
    ({ dir: root, cleanup } = await tempDir());
  });
  after(() => cleanup());

  it('faz fsync de verdade no SO atual (Windows: handle r+ → FlushFileBuffers; POSIX: r + fsync)', async () => {
    const { warns, logger } = recordingLogger();
    const spy = await spyFs();
    let ok: boolean;
    try {
      ok = await fsyncDir(root, { logger });
    } finally {
      spy.restore();
    }
    assert.equal(ok, true, warns.join('\n'));
    const open = spy.events.find(isOp('open', root));
    assert.equal(open?.extra, process.platform === 'win32' ? 'r+' : 'r');
    assertOrder(spy.events, [
      ['open do diretório', isOp('open', root)],
      ['sync do diretório', isOp('sync', root)],
      ['close do diretório', isOp('close', root)],
    ]);
    assert.deepEqual(warns, []);
  });

  it('no Windows, abrir só para leitura dá EPERM no fsync: vira aviso, não exceção', { skip: process.platform !== 'win32' }, async () => {
    const { warns, logger } = recordingLogger();
    // Força o caminho POSIX (open 'r') no Windows de verdade: é o EPERM real do FlushFileBuffers.
    assert.equal(await fsyncDir(root, { logger, platform: 'linux' }), false);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /EPERM/);
  });

  it('Windows: open do diretório recusado (EISDIR/EPERM) → no-op com um aviso só, sem derrubar nada', async () => {
    const dir = path.join(root, 'win');
    await fsp.mkdir(dir);
    const { warns, logger } = recordingLogger();
    const spy = await spyFs((op, p) => (op === 'open' && p === path.resolve(dir) ? errno('EISDIR', 'open') : undefined));
    try {
      assert.equal(await fsyncDir(dir, { logger, platform: 'win32' }), false);
      assert.equal(await fsyncDir(dir, { logger, platform: 'win32' }), false);
    } finally {
      spy.restore();
    }
    assert.equal(spy.events.find(isOp('open', dir))?.extra, undefined, 'open falhou antes de abrir');
    assert.equal(warns.length, 1, 'avisa uma vez por diretório e código');
    assert.match(warns[0], /EISDIR/);
  });

  it('fsync do diretório falhando (POSIX) também só avisa; diretório inexistente idem', async () => {
    const dir = path.join(root, 'posix');
    await fsp.mkdir(dir);
    const { warns, logger } = recordingLogger();
    const spy = await spyFs((op, p) => (op === 'sync' && p === path.resolve(dir) ? errno('EINVAL', 'fsync') : undefined));
    try {
      assert.equal(await fsyncDir(dir, { logger, platform: 'linux' }), false);
    } finally {
      spy.restore();
    }
    assert.ok(spy.events.some(isOp('close', dir)), 'fecha o handle mesmo com erro');
    assert.equal(await fsyncDir(path.join(root, 'nao-existe'), { logger }), false);
    assert.equal(warns.length, 2);
  });
});

describe('mkdirDurable', () => {
  it('faz fsync do pai de cada pasta criada (e nada quando já existe)', async () => {
    const { dir: root, cleanup } = await tempDir();
    try {
      const synced: string[] = [];
      const target = path.join(root, '2026', '11');
      await mkdirDurable(target, (d) => Promise.resolve(synced.push(path.resolve(d))));
      assert.deepEqual(synced, [path.resolve(root), path.resolve(root, '2026')]);
      synced.length = 0;
      await mkdirDurable(target, (d) => Promise.resolve(synced.push(d)));
      assert.deepEqual(synced, []);
    } finally {
      await cleanup();
    }
  });
});

describe('writeStreamDurable', () => {
  it('escreve tudo, faz fh.sync() e só então fecha; erro de disco vira DiskError com a fase', async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, 'a.part');
    try {
      let spy = await spyFs();
      try {
        await writeStreamDurable(file, [Readable.from([Buffer.from('abc'), Buffer.from('def')])], { flags: 'w' });
      } finally {
        spy.restore();
      }
      assert.equal(await fsp.readFile(file, 'utf8'), 'abcdef');
      const [, iSync] = assertOrder(spy.events, [
        ['write', isOp('write', file)],
        ['sync', isOp('sync', file)],
        ['close', isOp('close', file)],
      ]);
      assert.ok(!spy.events.slice(iSync).some(isOp('write', file)), 'nenhuma escrita depois do fsync');

      spy = await spyFs((op, p) => (op === 'sync' && p === path.resolve(file) ? errno('ENOSPC', 'fsync') : undefined));
      try {
        await assert.rejects(
          writeStreamDurable(file, [Readable.from([Buffer.from('x')])], { flags: 'a' }),
          (err: unknown) => err instanceof DiskError && err.phase === 'sync' && isNoSpace(err),
        );
      } finally {
        spy.restore();
      }
      assert.ok(spy.events.some(isOp('close', file)), 'fecha o handle depois do fsync que falhou');

      spy = await spyFs((op, p) => (op === 'write' && p === path.resolve(file) ? errno('EIO') : undefined));
      try {
        await assert.rejects(
          writeStreamDurable(file, [Readable.from([Buffer.from('y')])], { flags: 'a' }),
          (err: unknown) => err instanceof DiskError && err.phase === 'write' && err.code === 'EIO',
        );
      } finally {
        spy.restore();
      }
      assert.ok(!spy.events.some(isOp('sync', file)), 'sem fsync quando a escrita falha');
    } finally {
      await cleanup();
    }
  });
});

describe('writeFileAtomic (pending-reports.json, config.json, activity.json)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  before(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  after(() => cleanup());

  it('tmp → escrita → fsync → close → rename → fsync do diretório', async () => {
    const file = path.join(dir, 'pending-reports.json');
    const spy = await spyFs();
    try {
      await writeFileAtomic(file, JSON.stringify([{ fileId: 'f1' }]), 0o600, { syncDir: (d) => Promise.resolve(spy.mark('syncDir', path.resolve(d))) });
    } finally {
      spy.restore();
    }
    const tmpOpen = spy.events.find((e) => e.op === 'open' && e.path.startsWith(path.resolve(file) + '.') && e.path.endsWith('.tmp'));
    assert.ok(tmpOpen, 'grava num arquivo temporário ao lado');
    const tmp = tmpOpen.path;
    assertOrder(spy.events, [
      // (fh.writeFile escreve por dentro do Node, sem passar por FileHandle#write)
      ['open tmp', isOp('open', tmp)],
      ['sync tmp', isOp('sync', tmp)],
      ['close tmp', isOp('close', tmp)],
      ['rename tmp → final', (e) => e.op === 'rename' && e.path === tmp && e.extra === path.resolve(file)],
      ['fsync do diretório', (e) => isMark('syncDir')(e) && e.extra === path.resolve(dir)],
    ]);
    assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), [{ fileId: 'f1' }]);
    assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  it('fsync falhando: não faz rename, mantém o conteúdo antigo inteiro e apaga o tmp', async () => {
    const file = path.join(dir, 'pending-reports.json');
    await writeFileAtomic(file, '["antigo"]');
    const spy = await spyFs((op, p) => (op === 'sync' && p.endsWith('.tmp') ? errno('EIO', 'fsync') : undefined));
    try {
      await assert.rejects(writeFileAtomic(file, '["novo"]'), /EIO/);
    } finally {
      spy.restore();
    }
    assert.ok(!spy.events.some((e) => e.op === 'rename'), 'sem rename depois de fsync que falhou');
    assert.equal(await fsp.readFile(file, 'utf8'), '["antigo"]');
    assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });
});
