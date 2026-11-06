process.env.TZ = 'America/Sao_Paulo';

import assert from 'node:assert/strict';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fsyncDir } from './fs-utils';
import { monthFolder, PARTS_DIR_NAME, sanitizeFileName, Storage, withCollisionSuffix } from './storage';
import { errno, sha256, spyFs, tempDir } from './test-helpers';

describe('sanitizeFileName', () => {
  const cases: [string, string][] = [
    ['IMG_20261103_103000.jpg', 'IMG_20261103_103000.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\System32\\evil.dll', 'evil.dll'],
    ['C:\\Users\\x\\foto.jpg', 'foto.jpg'],
    ['/abs/path/video.mp4', 'video.mp4'],
    ['..', 'arquivo'],
    ['.', 'arquivo'],
    ['', 'arquivo'],
    ['a<b>c:d"e|f?g*h.jpg', 'a_b_c_d_e_f_g_h.jpg'],
    ['nome com fim.  ...', 'nome com fim'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['LPT1.tar.gz', '_LPT1.tar.gz'],
    ['tab\there\u0001.pdf', 'tab_here_.pdf'],
    ['Contrato_aluguel.pdf', 'Contrato_aluguel.pdf'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => assert.equal(sanitizeFileName(input), expected));
  }

  it('limita o tamanho preservando a extensão', () => {
    const long = 'a'.repeat(400) + '.jpg';
    const out = sanitizeFileName(long);
    assert.ok(Buffer.byteLength(out) <= 200);
    assert.ok(out.endsWith('.jpg'));
  });

  it('normaliza para NFC', () => {
    assert.equal(sanitizeFileName('Gastos_cafe\u0301.xlsx'), 'Gastos_café.xlsx');
  });
});

describe('monthFolder (fuso local do PC)', () => {
  it('usa o mês local, não o UTC', () => {
    // 01/12 às 01:00 UTC ainda é 30/11 em São Paulo (UTC-3).
    assert.equal(monthFolder('2026-12-01T01:00:00.000Z'), '2026/11');
    assert.equal(monthFolder('2026-11-03T15:00:00.000Z'), '2026/11');
    assert.equal(monthFolder('2026-01-01T05:00:00.000Z'), '2026/01');
  });
  it('data inválida cai na data atual', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    assert.equal(monthFolder('não é data', now), '2026/08');
    assert.equal(monthFolder(null, now), '2026/08');
  });
});

describe('withCollisionSuffix', () => {
  it('acrescenta (n) antes da extensão', () => {
    assert.equal(withCollisionSuffix('foto.jpg', 1), 'foto.jpg');
    assert.equal(withCollisionSuffix('foto.jpg', 2), 'foto (2).jpg');
    assert.equal(withCollisionSuffix('arquivo', 3), 'arquivo (3)');
    assert.equal(withCollisionSuffix('a.tar.gz', 2), 'a.tar (2).gz');
  });
});

describe('Storage.placeVerified', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let storage: Storage;
  before(async () => {
    ({ dir: root, cleanup } = await tempDir());
    storage = new Storage(() => root);
  });
  after(() => cleanup());

  async function part(key: string, content: string) {
    await storage.ensurePartsDir();
    const p = storage.partPath(key);
    await fsp.writeFile(p, content);
    return { partPath: p, hash: sha256(content) };
  }

  it('organiza em AAAA/MM/nome e remove o .part', async () => {
    const p = await part('a1', 'foto-1');
    const r = await storage.placeVerified({ ...p, name: 'IMG_1.jpg', takenAt: '2026-11-03T12:00:00Z' });
    assert.equal(r.relativePath, '2026/11/IMG_1.jpg');
    assert.equal(r.alreadyExisted, false);
    assert.equal(await fsp.readFile(path.join(root, '2026', '11', 'IMG_1.jpg'), 'utf8'), 'foto-1');
    assert.equal(existsSync(p.partPath), false);
  });

  it('mesmo nome e mesmo hash = idempotente (não duplica)', async () => {
    const p = await part('a2', 'foto-1');
    const r = await storage.placeVerified({ ...p, name: 'IMG_1.jpg', takenAt: '2026-11-03T12:00:00Z' });
    assert.equal(r.relativePath, '2026/11/IMG_1.jpg');
    assert.equal(r.alreadyExisted, true);
    assert.equal(existsSync(p.partPath), false);
    assert.deepEqual(await fsp.readdir(path.join(root, '2026', '11')), ['IMG_1.jpg']);
  });

  it('mesmo nome e hash diferente → " (2)", depois " (3)"', async () => {
    const p2 = await part('a3', 'foto-2');
    const r2 = await storage.placeVerified({ ...p2, name: 'IMG_1.jpg', takenAt: '2026-11-03T12:00:00Z' });
    assert.equal(r2.relativePath, '2026/11/IMG_1 (2).jpg');
    const p3 = await part('a4', 'foto-3');
    const r3 = await storage.placeVerified({ ...p3, name: 'IMG_1.jpg', takenAt: '2026-11-03T12:00:00Z' });
    assert.equal(r3.relativePath, '2026/11/IMG_1 (3).jpg');
    // E o conteúdo da (2) reenviado volta a cair na (2), sem criar (4).
    const again = await part('a5', 'foto-2');
    const r4 = await storage.placeVerified({ ...again, name: 'IMG_1.jpg', takenAt: '2026-11-03T12:00:00Z' });
    assert.equal(r4.relativePath, '2026/11/IMG_1 (2).jpg');
    assert.equal(r4.alreadyExisted, true);
  });

  it('nome com ../ nunca sai da pasta escolhida', async () => {
    const p = await part('a6', 'malicioso');
    const r = await storage.placeVerified({ ...p, name: '../../../../tmp/evil.sh', takenAt: '2026-10-02T12:00:00Z' });
    assert.equal(r.relativePath, '2026/10/evil.sh');
    assert.ok(r.absolutePath.startsWith(root + path.sep));
  });

  it('colocações simultâneas do mesmo nome não se sobrescrevem', async () => {
    const parts = await Promise.all(['x1', 'x2', 'x3'].map((k, i) => part(k, `conteudo-${i}`)));
    const results = await Promise.all(parts.map((p) => storage.placeVerified({ ...p, name: 'doc.pdf', takenAt: '2026-09-11T12:00:00Z' })));
    assert.deepEqual(results.map((r) => r.relativePath).sort(), ['2026/09/doc (2).pdf', '2026/09/doc (3).pdf', '2026/09/doc.pdf']);
  });

  it('partPath recusa IDs com caracteres perigosos', () => {
    assert.throws(() => storage.partPath('../x'));
    assert.throws(() => storage.partPath('a/b'));
    assert.ok(storage.partPath('relay-abc_123').includes(PARTS_DIR_NAME));
  });
});

describe('Storage: fsync dos diretórios', () => {
  it('rename e depois fsync do destino, da pasta de parciais e dos pais de pastas novas; idempotente também sincroniza', async () => {
    const { dir: root, cleanup } = await tempDir();
    try {
      const synced: string[] = [];
      const storage = new Storage(() => root, { syncDir: (d) => Promise.resolve(synced.push(path.relative(root, path.resolve(d)) || '.')) });
      await storage.ensurePartsDir();
      assert.deepEqual(synced, ['.'], 'pasta de parciais nova → fsync da raiz');
      synced.length = 0;

      const p = storage.partPath('d1');
      await fsp.writeFile(p, 'conteudo');
      await storage.placeVerified({ partPath: p, hash: sha256('conteudo'), name: 'a.jpg', takenAt: '2024-05-05T12:00:00Z' });
      assert.deepEqual(synced, ['.', '2024', path.join('2024', '05'), PARTS_DIR_NAME]);
      synced.length = 0;

      await fsp.writeFile(p, 'conteudo');
      const again = await storage.placeVerified({ partPath: p, hash: sha256('conteudo'), name: 'a.jpg', takenAt: '2024-05-05T12:00:00Z' });
      assert.equal(again.alreadyExisted, true);
      assert.deepEqual(synced, [path.join('2024', '05')], 'pasta já existia: só o fsync do destino');
    } finally {
      await cleanup();
    }
  });

  it('fsync do diretório que falha não impede salvar (fsyncDir nunca lança)', async () => {
    const { dir: root, cleanup } = await tempDir();
    try {
      const storage = new Storage(() => root, { syncDir: (d) => fsyncDir(d, { platform: 'win32' }) });
      const spy = await spyFs((op, file) => (op === 'open' && !path.extname(file) ? errno('EISDIR', 'open') : undefined));
      try {
        await storage.ensurePartsDir();
        const p = storage.partPath('d2');
        await fsp.writeFile(p, 'x');
        const r = await storage.placeVerified({ partPath: p, hash: sha256('x'), name: 'b.txt', takenAt: '2024-06-01T12:00:00Z' });
        assert.equal(r.relativePath, '2024/06/b.txt');
      } finally {
        spy.restore();
      }
    } finally {
      await cleanup();
    }
  });
});
