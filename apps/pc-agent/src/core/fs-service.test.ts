// Pastas liberadas: raízes, resolução de caminhos (links, bloqueio, NFC/NFD), idempotência, limites, auditoria e
// cada operação contra uma pasta temporária real (contrato §10.2–§10.4, §10.10).
import assert from 'node:assert/strict';
import { existsSync, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  FS_RPC_MAX_PLAINTEXT_BYTES,
  parseFsRequest,
  type FsBatchResponse,
  type FsListResponse,
  type FsRequest,
  type FsRpcResult,
} from '@arkivo/shared';
import { parseDirAttributesOutput, windowsDirAttributes } from './fs-attrs';
import { FsAuditLog } from './fs-audit';
import { DRIVE_ROOT_WRITE_MESSAGE, driveRootWriteError, fsErrorFromErrno, type FsOpError } from './fs-errors';
import { ThumbService } from './fs-thumbs';
import { RootRejectError, RootReplaceRequiredError, buildFsSystemContext, defaultRootLabel, driveRootLabel } from './fs-roots';
import type { FsCallContext } from './fs-service';
import { fsKit, fsTempDir, hostFsPlatform, sleep, writeTree, type FsKit } from './test-helpers';

const LAN: FsCallContext = { phoneId: 'phone-1', via: 'lan' };
const REMOTE: FsCallContext = { phoneId: 'phone-1', via: 'remote' };
let rid = 0;
const reqId = () => `req-${String(++rid).padStart(20, '0')}`;

function req(input: Record<string, unknown>): FsRequest {
  const p = parseFsRequest(input);
  if (!p.ok) throw new Error(`pedido inválido no teste: ${p.error.message}`);
  return p.request;
}

async function run<T = unknown>(k: FsKit, input: Record<string, unknown>, ctx = LAN): Promise<FsRpcResult<T>> {
  return (await k.service.execute(ctx, req(input))) as FsRpcResult<T>;
}

async function ok<T = unknown>(k: FsKit, input: Record<string, unknown>, ctx = LAN): Promise<T> {
  const r = await run<T>(k, input, ctx);
  if (!r.ok) assert.fail(`esperava ok, veio ${r.error.code}: ${r.error.message}`);
  return r.data;
}

async function errCode(k: FsKit, input: Record<string, unknown>, ctx = LAN): Promise<string> {
  const r = await run(k, input, ctx);
  assert.equal(r.ok, false, 'esperava erro');
  return r.ok ? '' : r.error.code;
}

/** Link de pasta: junction no Windows (não precisa de administrador). */
async function linkDir(target: string, link: string): Promise<void> {
  await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Link de arquivo; `false` se o sistema não deixa (Windows sem modo de desenvolvedor). */
async function linkFile(target: string, link: string): Promise<boolean> {
  try {
    await fsp.symlink(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('pastas liberadas: raízes (§10.2)', () => {
  let k: FsKit;
  beforeEach(async () => {
    k = await fsKit();
  });
  afterEach(() => k.cleanup());

  it('adicionar a primeira pasta liga o acesso; id de 22 caracteres e rótulo = nome da pasta', async () => {
    assert.equal(k.roots.enabled, false);
    const r = await k.addRoot('Fotos');
    assert.match(r.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(k.roots.enabled, true);
    assert.equal(k.roots.get(r.id)?.label, 'Fotos');
    const roots = await ok<{
      roots: { id: string; label: string; available: boolean; trashAvailable: boolean; drive: string | null }[];
      pcName: string;
    }>(k, { op: 'roots' });
    assert.equal(roots.pcName, 'PC-TESTE');
    assert.deepEqual(
      roots.roots.map((x) => [x.id, x.label, x.available, x.trashAvailable, x.drive]),
      [[r.id, 'Fotos', true, true, 'X:']],
    );
    // O caminho absoluto nunca sai do PC.
    assert.ok(!JSON.stringify(roots).includes(k.base.replace(/\\/g, '\\\\')));
  });

  it('recusa sobreposição, repetida, pastas bloqueadas e mais de 32', async () => {
    const a = await k.addRoot('A');
    await fsp.mkdir(path.join(a.abs, 'dentro'));
    await assert.rejects(k.roots.add(a.abs), (e: Error) => e instanceof RootRejectError && e.message === 'Esta pasta já está liberada.');
    await assert.rejects(k.roots.add(path.join(a.abs, 'dentro')), { message: 'Esta pasta está dentro de "A", que já está liberada.' });
    await assert.rejects(k.roots.add(k.base), { message: 'Esta pasta contém "A", que já está liberada. Remova "A" antes.' });
    // pasta de dados do Arkivo (extraBlocked) e pasta de credenciais
    await assert.rejects(k.roots.add(k.dataDir), { message: 'Esta pasta é de uso interno do Arkivo.' });
    await fsp.mkdir(path.join(k.tmp, 'x', '.ssh'), { recursive: true });
    await assert.rejects(k.roots.add(path.join(k.tmp, 'x', '.ssh')), {
      message: 'Esta pasta guarda chaves e senhas e não pode ser liberada.',
    });
    await assert.rejects(k.roots.add(path.join(k.tmp, 'nao-existe')), { message: 'Não foi possível abrir esta pasta.' });
    for (let i = 1; i < 32; i++) await k.addRoot(`R${i}`);
    await assert.rejects(k.addRoot('R32'), { message: 'Limite de 32 pastas.' });
  });

  it('[2026-11-06] Windows: C:\\ inteiro pode (com aviso); C:\\Windows não; no macOS/Linux "/" continua recusado', async () => {
    if (hostFsPlatform === 'windows') {
      // Só confere (realpath + stat): nada é liberado nem gravado em C:\.
      const plan = await k.roots.plan('C:\\');
      assert.deepEqual(
        { requested: plan.requested, absPath: plan.absPath.toUpperCase(), whole: plan.wholeDrive, sys: plan.systemDrive, drive: plan.drive, label: plan.label, n: plan.replaces.length },
        { requested: 'C:\\', absPath: 'C:\\', whole: true, sys: true, drive: 'C:', label: 'Disco local (C:)', n: 0 },
      );
      assert.equal((await k.roots.plan('C:\\', { label: 'Windows (C:)' })).label, 'Windows (C:)');
      await assert.rejects(k.roots.plan('C:\\Windows'), { message: 'Esta pasta é do sistema e não pode ser liberada.' });
      await assert.rejects(k.roots.plan('C:\\Program Files'), { message: 'Esta pasta é do sistema e não pode ser liberada.' });
      // Pasta comum não é "unidade inteira": nada de aviso.
      const folder = await k.roots.plan(k.base);
      assert.equal(folder.wholeDrive, false);
      assert.equal(folder.systemDrive, false);
    } else {
      await assert.rejects(k.roots.plan('/'), {
        message: 'Não é possível liberar o disco inteiro do sistema. Escolha uma pasta dentro dele.',
      });
    }
  });

  it('[2026-11-06] unidade inteira com pastas liberadas dentro: troca só com confirmação, numa gravação só', async (t) => {
    if (hostFsPlatform !== 'windows') return t.skip('unidade inteira é coisa do Windows');
    const a = await k.addRoot('Fotos');
    const b = await k.addRoot('Documentos');
    await writeTree(a.abs, { '.arkivo-fs-parciais/u.part': 'x' });
    // A unidade D:/E: do teste não existe: a unidade de verdade das pastas do teste é a do sistema.
    const drive = path.parse(k.base).root;
    const plan = await k.roots.plan(drive);
    assert.deepEqual(plan.replaces.map((r) => r.id).sort(), [a.id, b.id].sort());
    // Sem confirmar (ou confirmando só uma) → recusa, nada muda.
    await assert.rejects(k.roots.add(drive), (e: Error) => e instanceof RootReplaceRequiredError && /"Fotos", "Documentos"|"Documentos", "Fotos"/.test(e.message));
    await assert.rejects(k.roots.add(drive, { replace: [a.id] }), RootReplaceRequiredError);
    assert.deepEqual(k.roots.roots.map((r) => r.id), [a.id, b.id]);
    let saves = 0;
    k.roots.on('changed', () => saves++);
    const whole = await k.roots.add(drive, { replace: [a.id, b.id], label: 'Disco local (C:)' });
    assert.equal(saves, 1, 'uma gravação só');
    assert.deepEqual(k.roots.roots.map((r) => [r.id, r.label]), [[whole.id, 'Disco local (C:)']]);
    assert.equal(existsSync(path.join(a.abs, '.arkivo-fs-parciais')), false, 'envios parciais da pasta trocada apagados');
    assert.equal(existsSync(a.abs), true, 'a pasta em si continua no disco');
    assert.equal(k.roots.enabled, true);
    // As pastas trocadas somem para o celular.
    assert.equal(await errCode(k, { op: 'list', rootId: a.id, path: '' }), 'ROOT_REMOVED');
    // Pasta dentro da unidade já liberada inteira → "já está liberada"; a unidade de novo → "já está liberada inteira".
    await assert.rejects(k.roots.plan(a.abs), { message: `Esta pasta já está liberada: ela fica em "Disco local (C:)", a unidade ${drive.slice(0, 2).toUpperCase()} inteira.` });
    await assert.rejects(k.roots.plan(drive), { message: 'Esta unidade já está liberada inteira.' });
    // A unidade fica só na memória deste teste (nenhuma operação é feita nela; `remove` nem é chamado, para não
    // tocar em nada fora da pasta temporária).
  });

  it('pasta comum que contém pastas liberadas continua recusada (só a unidade inteira oferece a troca)', async () => {
    const a = await k.addRoot('A');
    const plan = k.roots.plan(k.base);
    await assert.rejects(plan, { message: 'Esta pasta contém "A", que já está liberada. Remova "A" antes.' });
    assert.ok(a.id);
  });

  it('rótulos padrão, renomear e remover (remover apaga os envios parciais)', async () => {
    assert.equal(defaultRootLabel('E:\\', 'windows'), 'Disco local (E:)');
    assert.equal(driveRootLabel({ name: 'C:', volumeLabel: null, kind: 'fixed' }, 'windows'), 'Disco local (C:)');
    assert.equal(driveRootLabel({ name: 'C:', volumeLabel: 'Windows', kind: 'fixed' }, 'windows'), 'Windows (C:)');
    assert.equal(driveRootLabel({ name: 'E:', volumeLabel: null, kind: 'removable' }, 'windows'), 'Pen drive (E:)');
    assert.equal(driveRootLabel({ name: 'E:', volumeLabel: '  ', kind: 'removable' }, 'windows'), 'Pen drive (E:)');
    assert.equal(driveRootLabel({ name: 'Z:', volumeLabel: null, kind: 'network' }, 'windows'), 'Unidade de rede (Z:)');
    assert.equal(driveRootLabel({ name: 'D:', volumeLabel: null, kind: 'cdrom' }, 'windows'), 'CD/DVD (D:)');
    const long = driveRootLabel({ name: 'F:', volumeLabel: 'x'.repeat(80), kind: 'fixed' }, 'windows');
    assert.equal([...long].length, 64);
    assert.ok(long.endsWith(' (F:)'), 'a letra nunca é cortada');
    assert.equal(driveRootLabel({ name: 'HD', volumeLabel: null, kind: 'removable' }, 'macos'), 'HD');
    assert.equal(defaultRootLabel('\\\\nas\\fotos', 'windows'), 'fotos');
    assert.equal(defaultRootLabel('D:\\Fotos\\2026', 'windows'), '2026');
    assert.equal(defaultRootLabel('/Volumes/HD', 'macos'), 'HD');
    const r = await k.addRoot('Docs');
    await k.roots.rename(r.id, '  Documentos  ');
    assert.equal(k.roots.get(r.id)?.label, 'Documentos');
    await assert.rejects(k.roots.rename(r.id, ''), { message: 'Digite um nome.' });
    await assert.rejects(k.roots.rename(r.id, 'x'.repeat(65)), RootRejectError);
    await writeTree(r.abs, { '.arkivo-fs-parciais/u.part': 'x' });
    await k.roots.remove(r.id);
    assert.equal(existsSync(path.join(r.abs, '.arkivo-fs-parciais')), false);
    assert.equal(await errCode(k, { op: 'list', rootId: r.id, path: '' }), 'ROOT_REMOVED');
  });

  it('contexto do sistema com as variáveis do Windows e a pasta de dados em extraBlocked', () => {
    const ctx = buildFsSystemContext({
      platform: 'windows',
      home: 'C:\\Users\\ana',
      env: {
        SystemDrive: 'C:',
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramW6432: 'C:\\Program Files',
        ProgramData: 'C:\\ProgramData',
      },
      extraBlocked: ['C:\\Users\\ana\\AppData\\Roaming\\Arkivo para PC'],
    });
    assert.deepEqual(ctx.programFiles, ['C:\\Program Files', 'C:\\Program Files (x86)']);
    assert.equal(ctx.windowsDir, 'C:\\Windows');
    assert.equal(ctx.programData, 'C:\\ProgramData');
    assert.deepEqual(ctx.extraBlocked, ['C:\\Users\\ana\\AppData\\Roaming\\Arkivo para PC']);
  });

  it('interruptor desligado → FS_DISABLED em toda operação; raiz desconectada → ROOT_UNAVAILABLE', async () => {
    const r = await k.addRoot('Fotos');
    await k.roots.setEnabled(false);
    assert.equal(await errCode(k, { op: 'roots' }), 'FS_DISABLED');
    assert.equal(await errCode(k, { op: 'list', rootId: r.id, path: '' }), 'FS_DISABLED');
    await k.roots.setEnabled(true);
    await fsp.rm(r.abs, { recursive: true });
    assert.equal(await errCode(k, { op: 'list', rootId: r.id, path: '' }), 'ROOT_UNAVAILABLE');
    const roots = await ok<{ roots: { available: boolean; trashAvailable: boolean }[] }>(k, { op: 'roots' });
    assert.deepEqual(
      roots.roots.map((x) => [x.available, x.trashAvailable]),
      [[false, false]],
    );
  });
});

describe('pastas liberadas: resolução de caminhos (§10.2)', () => {
  let k: FsKit;
  let root: { id: string; abs: string };
  beforeEach(async () => {
    k = await fsKit();
    root = await k.addRoot('Raiz');
    await writeTree(root.abs, { 'Fotos/a.jpg': 'aaa', 'Fotos/sub/b.jpg': 'bbbb', 'doc.txt': 'texto' });
    await writeTree(k.base, { 'Fora/segredo.txt': 'não pode' });
  });
  afterEach(() => k.cleanup());

  it('caminhos inválidos já saem do parseFsRequest como FORBIDDEN_PATH', () => {
    for (const p of ['../Fora', 'Fotos/../../x', '/abs', 'C:/x', 'a\\b', 'a//b', '.arkivo-fs-parciais']) {
      const r = parseFsRequest({ op: 'stat', rootId: root.id, path: p });
      assert.equal(r.ok, false, p);
      assert.equal(!r.ok && r.error.code, 'FORBIDDEN_PATH', p);
    }
  });

  it('link (junction) para fora da raiz: omitido na lista e recusado direto', async () => {
    await linkDir(path.join(k.base, 'Fora'), path.join(root.abs, 'atalho-fora'));
    const list = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '' });
    assert.ok(!list.entries.some((e) => e.name === 'atalho-fora'));
    assert.equal(list.omitted, 1);
    assert.equal(await errCode(k, { op: 'list', rootId: root.id, path: 'atalho-fora' }), 'FORBIDDEN_PATH');
    assert.equal(await errCode(k, { op: 'stat', rootId: root.id, path: 'atalho-fora/segredo.txt' }), 'FORBIDDEN_PATH');
    assert.equal(
      await errCode(k, { op: 'rename', requestId: reqId(), rootId: root.id, path: 'atalho-fora', newName: 'x' }),
      'FORBIDDEN_PATH',
    );
    assert.equal(
      await errCode(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: 'atalho-fora', name: 'nova' }),
      'FORBIDDEN_PATH',
    );
    assert.equal(existsSync(path.join(k.base, 'Fora', 'nova')), false);
  });

  it('link para dentro da mesma raiz funciona; rename e trash agem no próprio link', async () => {
    await linkDir(path.join(root.abs, 'Fotos'), path.join(root.abs, 'atalho'));
    const list = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: 'atalho' });
    assert.deepEqual(
      list.entries.map((e) => e.name),
      ['sub', 'a.jpg'],
    );
    const st = await ok<{ entry: { type: string } }>(k, { op: 'stat', rootId: root.id, path: 'atalho/a.jpg' });
    assert.equal(st.entry.type, 'file');
    await ok(k, { op: 'rename', requestId: reqId(), rootId: root.id, path: 'atalho', newName: 'atalho2' });
    assert.ok(existsSync(path.join(root.abs, 'Fotos', 'a.jpg')), 'o destino do link continua intacto');
    assert.ok((await fsp.lstat(path.join(root.abs, 'atalho2'))).isSymbolicLink());
    const t = await ok<FsBatchResponse>(k, { op: 'trash', requestId: reqId(), rootId: root.id, paths: ['atalho2'] });
    assert.equal(t.results[0].ok, true);
    assert.ok(existsSync(path.join(root.abs, 'Fotos', 'a.jpg')), 'apagar o link não apaga o conteúdo');
  });

  it('link de arquivo para fora da raiz é recusado', async (t) => {
    if (!(await linkFile(path.join(k.base, 'Fora', 'segredo.txt'), path.join(root.abs, 'segredo.txt'))))
      return t.skip('sem permissão para symlink de arquivo');
    assert.equal(await errCode(k, { op: 'stat', rootId: root.id, path: 'segredo.txt' }), 'FORBIDDEN_PATH');
    const list = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '' });
    assert.ok(!list.entries.some((e) => e.name === 'segredo.txt'));
  });

  it('itens bloqueados dentro da raiz (credenciais, .arkivo-*) são omitidos e recusados', async () => {
    await writeTree(root.abs, { '.ssh/id_rsa': 'chave', '.arkivo-fs-parciais/x.part': 'p', '.aws/': '' });
    const list = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', includeHidden: true });
    assert.deepEqual(list.entries.map((e) => e.name).sort(), ['doc.txt', 'Fotos'].sort());
    assert.equal(list.omitted, 3);
    assert.equal(await errCode(k, { op: 'stat', rootId: root.id, path: '.ssh' }), 'FORBIDDEN_PATH');
    assert.equal(await errCode(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: '', name: '.gnupg' }), 'FORBIDDEN_PATH');
  });

  it('NFC/NFD: nome gravado em NFD no disco é achado pelo caminho em NFC (fallback do Linux)', async () => {
    const k2 = await fsKit({ normalizationFallback: true });
    try {
      const r = await k2.addRoot('Raiz');
      const nfd = 'Cafe\u0301';
      await writeTree(r.abs, { [`${nfd}/Ma\u0303e.txt`]: 'oi' });
      const st = await ok<{ entry: { name: string; size: number } }>(k2, { op: 'stat', rootId: r.id, path: 'Café/Mãe.txt' });
      assert.equal(st.entry.name, 'Mãe.txt');
      assert.equal(st.entry.size, 2);
      const list = await ok<FsListResponse>(k2, { op: 'list', rootId: r.id, path: '' });
      assert.deepEqual(
        list.entries.map((e) => e.name),
        ['Café'],
      );
      await ok(k2, { op: 'rename', requestId: reqId(), rootId: r.id, path: 'Café/Mãe.txt', newName: 'Pai.txt' });
      assert.ok(existsSync(path.join(r.abs, nfd, 'Pai.txt')));
    } finally {
      await k2.cleanup();
    }
  });
});

describe('pastas liberadas: list e stat (§10.4)', () => {
  let k: FsKit;
  let root: { id: string; abs: string };
  beforeEach(async () => {
    k = await fsKit();
    root = await k.addRoot('Raiz');
  });
  afterEach(() => k.cleanup());

  it('pastas primeiro, ordem natural; ocultos somem sem includeHidden; total e cursor', async () => {
    await writeTree(root.abs, {
      'foto10.jpg': '1',
      'foto2.jpg': '22',
      'Banco/': '',
      'arquivo.pdf': '333',
      '.oculto': 'x',
      'desktop.ini': 'x',
      'zeta/': '',
    });
    const all = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '' });
    assert.deepEqual(
      all.entries.map((e) => e.name),
      ['Banco', 'zeta', 'arquivo.pdf', 'foto2.jpg', 'foto10.jpg'],
    );
    assert.equal(all.total, 5);
    assert.equal(all.omitted, 0);
    assert.equal(all.nextCursor, null);
    const pdf = all.entries.find((e) => e.name === 'arquivo.pdf')!;
    assert.deepEqual(
      { type: pdf.type, size: pdf.size, mime: pdf.mime, hidden: pdf.hidden, hasThumb: pdf.hasThumb },
      { type: 'file', size: 3, mime: 'application/pdf', hidden: false, hasThumb: false },
    );
    assert.equal(all.entries.find((e) => e.name === 'foto2.jpg')!.hasThumb, true);
    assert.equal(all.entries.find((e) => e.name === 'Banco')!.size, null);
    const hidden = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', includeHidden: true });
    assert.equal(hidden.total, 7);
    assert.ok(hidden.entries.find((e) => e.name === '.oculto')!.hidden);

    const p1 = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 2 });
    assert.deepEqual(
      p1.entries.map((e) => e.name),
      ['Banco', 'zeta'],
    );
    assert.ok(p1.nextCursor);
    const p2 = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(
      p2.entries.map((e) => e.name),
      ['arquivo.pdf', 'foto2.jpg'],
    );
    const p3 = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(
      p3.entries.map((e) => e.name),
      ['foto10.jpg'],
    );
    assert.equal(p3.nextCursor, null);
    // cursor de listagem vencida/desconhecida: refaz e usa o deslocamento
    const again = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 2, cursor: 'naoexiste123.2' });
    assert.deepEqual(
      again.entries.map((e) => e.name),
      ['arquivo.pdf', 'foto2.jpg'],
    );
    assert.equal(await errCode(k, { op: 'list', rootId: root.id, path: '', cursor: 'lixo' }), 'VALIDATION_ERROR');
  });

  it('ordenar por tamanho e por data (desc); list num arquivo → NOT_A_DIRECTORY; inexistente → NOT_FOUND', async () => {
    await writeTree(root.abs, { 'p.txt': '1', 'g.txt': '123456', 'm.txt': '123', 'D/': '' });
    const old = new Date('2020-01-01T00:00:00Z');
    await fsp.utimes(path.join(root.abs, 'g.txt'), old, old);
    const bySize = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', sort: 'size', order: 'desc' });
    assert.deepEqual(
      bySize.entries.map((e) => e.name),
      ['D', 'g.txt', 'm.txt', 'p.txt'],
    );
    const byDate = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', sort: 'mtime' });
    assert.equal(byDate.entries[1].name, 'g.txt');
    assert.equal(byDate.entries[1].mtime, '2020-01-01T00:00:00.000Z');
    assert.equal(await errCode(k, { op: 'list', rootId: root.id, path: 'p.txt' }), 'NOT_A_DIRECTORY');
    assert.equal(await errCode(k, { op: 'list', rootId: root.id, path: 'nada' }), 'NOT_FOUND');
  });

  it('no remoto a página é cortada para caber no envelope (180 KiB), com nextCursor', async () => {
    const long = 'n'.repeat(240);
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`${long}${String(i).padStart(3, '0')}.docx`] = 'x';
    await writeTree(root.abs, files);
    const lan = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 500 });
    assert.equal(lan.entries.length, 500);
    const remote = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 500 }, REMOTE);
    assert.ok(remote.entries.length < 500 && remote.entries.length > 100, `${remote.entries.length} itens`);
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: remote })) <= FS_RPC_MAX_PLAINTEXT_BYTES);
    assert.ok(remote.nextCursor);
    const rest = await ok<FsListResponse>(k, { op: 'list', rootId: root.id, path: '', limit: 500, cursor: remote.nextCursor }, REMOTE);
    assert.equal(rest.entries[0].name, lan.entries[remote.entries.length].name, 'continua de onde parou');
  });

  it('stat da raiz usa o rótulo; atributo oculto do Windows entra em hidden', async () => {
    const st = await ok<{ entry: { name: string; type: string } }>(k, { op: 'stat', rootId: root.id, path: '' });
    assert.deepEqual(st.entry.name, 'Raiz');
    const k2 = await fsKit({ dirAttributes: async () => ({ hidden: new Set(['escondido.txt']), offline: new Set(['nuvem.jpg']) }) });
    try {
      const r = await k2.addRoot('R');
      await writeTree(r.abs, { 'escondido.txt': '1', 'nuvem.jpg': '2', 'normal.jpg': '3' });
      const l = await ok<FsListResponse>(k2, { op: 'list', rootId: r.id, path: '' });
      assert.deepEqual(
        l.entries.map((e) => [e.name, e.hasThumb]),
        [
          ['normal.jpg', true],
          ['nuvem.jpg', false],
        ],
      );
    } finally {
      await k2.cleanup();
    }
  });

  it('cmd /u dir: parse da saída e probe real no Windows', async (t) => {
    const parsed = parseDirAttributesOutput('a.txt\r\nCafé.jpg\r\n::arkivo:: \r\nnuvem.jpg\r\n');
    assert.deepEqual([...parsed.hidden], ['a.txt', 'Café.jpg']);
    assert.deepEqual([...parsed.offline], ['nuvem.jpg']);
    if (process.platform !== 'win32') return t.skip('só no Windows');
    await writeTree(root.abs, { 'olá oculto.txt': 'x', 'normal.txt': 'y' });
    const { execFileSync } = await import('node:child_process');
    execFileSync('attrib.exe', ['+h', path.join(root.abs, 'olá oculto.txt')]);
    const attrs = await windowsDirAttributes(root.abs);
    assert.ok(attrs.hidden.has('olá oculto.txt'), [...attrs.hidden].join(','));
    assert.ok(!attrs.hidden.has('normal.txt'));
  });
});

describe('pastas liberadas: mkdir, rename, move, trash e idempotência (§10.4)', () => {
  let k: FsKit;
  let root: { id: string; abs: string };
  beforeEach(async () => {
    k = await fsKit();
    root = await k.addRoot('Raiz');
    await writeTree(root.abs, { 'Fotos/a.jpg': 'a', 'Fotos/b.jpg': 'b', 'Docs/c.txt': 'c', 'x.txt': 'x' });
  });
  afterEach(() => k.cleanup());

  it('mkdir cria; de novo → created:false; com arquivo no nome → CONFLICT; nome do Windows proibido → INVALID_NAME', async () => {
    const r1 = await ok<{ path: string; created: boolean; entry: { type: string } }>(k, {
      op: 'mkdir',
      requestId: reqId(),
      rootId: root.id,
      path: 'Fotos',
      name: '2026',
    });
    assert.deepEqual([r1.path, r1.created, r1.entry.type], ['Fotos/2026', true, 'dir']);
    const r2 = await ok<{ created: boolean }>(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: 'Fotos', name: '2026' });
    assert.equal(r2.created, false);
    assert.equal(await errCode(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: '', name: 'x.txt' }), 'CONFLICT');
    const bad = parseFsRequest({ op: 'mkdir', requestId: reqId(), rootId: root.id, path: '', name: 'CON' });
    assert.equal(!bad.ok && bad.error.code, 'INVALID_NAME');
    assert.equal(await errCode(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: 'nao/existe', name: 'z' }), 'NOT_FOUND');
  });

  it('idempotência: mesmo requestId devolve a resposta guardada sem executar de novo (mesmo por outra via)', async () => {
    const id = reqId();
    const first = await run(k, { op: 'rename', requestId: id, rootId: root.id, path: 'x.txt', newName: 'y.txt' });
    assert.equal(first.ok, true);
    // Se executasse de novo daria NOT_FOUND (x.txt não existe mais).
    const again = await run(k, { op: 'rename', requestId: id, rootId: root.id, path: 'x.txt', newName: 'y.txt' }, REMOTE);
    assert.deepEqual(again, first);
    // Outro celular com o mesmo requestId é outra chave.
    const other = await run(
      k,
      { op: 'rename', requestId: id, rootId: root.id, path: 'x.txt', newName: 'y.txt' },
      { phoneId: 'phone-2', via: 'lan' },
    );
    assert.equal(!other.ok && other.error.code, 'NOT_FOUND');
    // Em execução → BUSY.
    const id2 = reqId();
    const p1 = run(k, { op: 'mkdir', requestId: id2, rootId: root.id, path: '', name: 'Nova' });
    const p2 = run(k, { op: 'mkdir', requestId: id2, rootId: root.id, path: '', name: 'Nova' });
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.ok, true);
    assert.equal(!b.ok && b.error.code, 'BUSY');
  });

  it('rename: conflito, mesmo nome, só maiúsculas (Windows/macOS)', async () => {
    assert.equal(
      await errCode(k, { op: 'rename', requestId: reqId(), rootId: root.id, path: 'Fotos/a.jpg', newName: 'b.jpg' }),
      'CONFLICT',
    );
    const same = await ok<{ path: string }>(k, {
      op: 'rename',
      requestId: reqId(),
      rootId: root.id,
      path: 'Fotos/a.jpg',
      newName: 'a.jpg',
    });
    assert.equal(same.path, 'Fotos/a.jpg');
    if (hostFsPlatform !== 'linux') {
      const r = await ok<{ path: string; entry: { name: string } }>(k, {
        op: 'rename',
        requestId: reqId(),
        rootId: root.id,
        path: 'Fotos/a.jpg',
        newName: 'A.jpg',
      });
      assert.equal(r.path, 'Fotos/A.jpg');
      assert.ok((await fsp.readdir(path.join(root.abs, 'Fotos'))).includes('A.jpg'));
    }
    const bad = parseFsRequest({ op: 'rename', requestId: reqId(), rootId: root.id, path: '', newName: 'x' });
    assert.equal(!bad.ok && bad.error.code, 'FORBIDDEN_PATH');
  });

  it('move: por item, conflito fail/skip/rename, já no destino, pasta para dentro dela mesma', async () => {
    await writeTree(root.abs, { 'Docs/a.jpg': 'outro' });
    const r = await ok<FsBatchResponse>(k, {
      op: 'move',
      requestId: reqId(),
      rootId: root.id,
      paths: ['Fotos/a.jpg', 'Fotos/b.jpg', 'nada.txt'],
      toPath: 'Docs',
    });
    assert.deepEqual(
      r.results.map((x) => (x.ok ? ['ok', x.newPath] : ['erro', x.error.code])),
      [
        ['erro', 'CONFLICT'],
        ['ok', 'Docs/b.jpg'],
        ['erro', 'NOT_FOUND'],
      ],
    );
    const skip = await ok<FsBatchResponse>(k, {
      op: 'move',
      requestId: reqId(),
      rootId: root.id,
      paths: ['Fotos/a.jpg'],
      toPath: 'Docs',
      onConflict: 'skip',
    });
    assert.deepEqual(skip.results[0], { path: 'Fotos/a.jpg', ok: true, newPath: null, skipped: true });
    const ren = await ok<FsBatchResponse>(k, {
      op: 'move',
      requestId: reqId(),
      rootId: root.id,
      paths: ['Fotos/a.jpg'],
      toPath: 'Docs',
      onConflict: 'rename',
    });
    assert.deepEqual(ren.results[0], { path: 'Fotos/a.jpg', ok: true, newPath: 'Docs/a (2).jpg' });
    assert.equal(await fsp.readFile(path.join(root.abs, 'Docs', 'a (2).jpg'), 'utf8'), 'a');
    const here = await ok<FsBatchResponse>(k, { op: 'move', requestId: reqId(), rootId: root.id, paths: ['Docs/c.txt'], toPath: 'Docs' });
    assert.deepEqual(here.results[0], { path: 'Docs/c.txt', ok: true, newPath: 'Docs/c.txt' });
    await writeTree(root.abs, { 'Fotos/sub/': '' });
    const self = await ok<FsBatchResponse>(k, { op: 'move', requestId: reqId(), rootId: root.id, paths: ['Fotos'], toPath: 'Fotos/sub' });
    assert.equal(!self.results[0].ok && self.results[0].error.code, 'INVALID_MOVE');
    const into = await ok<FsBatchResponse>(k, { op: 'move', requestId: reqId(), rootId: root.id, paths: ['Fotos'], toPath: 'Fotos' });
    assert.equal(!into.results[0].ok && into.results[0].error.code, 'INVALID_MOVE');
  });

  it('move entre raízes do mesmo volume', async () => {
    const other = await k.addRoot('Outra');
    const r = await ok<FsBatchResponse>(k, {
      op: 'move',
      requestId: reqId(),
      rootId: root.id,
      paths: ['x.txt'],
      toRootId: other.id,
      toPath: '',
    });
    assert.deepEqual(r.results[0], { path: 'x.txt', ok: true, newPath: 'x.txt' });
    assert.ok(existsSync(path.join(other.abs, 'x.txt')));
    assert.ok(!existsSync(path.join(root.abs, 'x.txt')));
  });

  it('trash: sem Lixeira → TRASH_UNAVAILABLE e nada é apagado; com Lixeira vai para a Lixeira; inexistente → NOT_FOUND', async () => {
    k.volume.trash = false;
    const no = await ok<FsBatchResponse>(k, { op: 'trash', requestId: reqId(), rootId: root.id, paths: ['x.txt', 'Fotos'] });
    assert.deepEqual(
      no.results.map((x) => !x.ok && x.error.code),
      ['TRASH_UNAVAILABLE', 'TRASH_UNAVAILABLE'],
    );
    assert.ok(existsSync(path.join(root.abs, 'x.txt')));
    assert.ok(existsSync(path.join(root.abs, 'Fotos', 'a.jpg')));
    assert.deepEqual(k.trashCalls, []);
    k.volume.trash = true;
    const yes = await ok<FsBatchResponse>(k, { op: 'trash', requestId: reqId(), rootId: root.id, paths: ['x.txt', 'Fotos', 'sumiu.txt'] });
    assert.deepEqual(
      yes.results.map((x) => (x.ok ? x.newPath : x.error.code)),
      [null, null, 'NOT_FOUND'],
    );
    assert.equal(k.trashCalls.length, 2);
    assert.ok(!existsSync(path.join(root.abs, 'x.txt')));
    assert.ok(existsSync(path.join(k.trashDir, '1-x.txt')), 'foi para a Lixeira (falsa), não apagado');
    const rootItself = parseFsRequest({ op: 'trash', requestId: reqId(), rootId: root.id, paths: [''] });
    assert.equal(!rootItself.ok && rootItself.error.code, 'FORBIDDEN_PATH');
  });

  it('pasta que contém o perfil do usuário não pode ser movida, renomeada nem apagada', async () => {
    const k2 = await fsKit();
    try {
      await fsp.mkdir(path.join(k2.tmp, 'home', 'Documentos'), { recursive: true });
      const top = await k2.roots.add(k2.tmp);
      const t = await ok<FsBatchResponse>(k2, { op: 'trash', requestId: reqId(), rootId: top.id, paths: ['home'] });
      assert.equal(!t.results[0].ok && t.results[0].error.code, 'FORBIDDEN_PATH');
      assert.equal(await errCode(k2, { op: 'rename', requestId: reqId(), rootId: top.id, path: 'home', newName: 'x' }), 'FORBIDDEN_PATH');
      assert.deepEqual(k2.trashCalls, []);
      // Dentro do perfil continua valendo.
      const inner = await ok<FsBatchResponse>(k2, { op: 'trash', requestId: reqId(), rootId: top.id, paths: ['home/Documentos'] });
      assert.equal(inner.results[0].ok, true);
    } finally {
      await k2.cleanup();
    }
  });

  it('[2026-11-06] a pasta do backup (e a de cima dela) também não pode ser movida, renomeada nem apagada', async () => {
    let backup: string | null = null;
    const k2 = await fsKit({ protectedDirs: () => [backup] });
    try {
      backup = path.join(k2.tmp, 'Imagens', 'Arkivo');
      await writeTree(k2.tmp, { 'Imagens/Arkivo/2026/11/foto.jpg': 'x', 'Imagens/outra.jpg': 'y', 'Livre/': '' });
      const top = await k2.roots.add(k2.tmp);
      for (const p of ['Imagens', 'Imagens/Arkivo']) {
        const t = await ok<FsBatchResponse>(k2, { op: 'trash', requestId: reqId(), rootId: top.id, paths: [p] });
        assert.equal(!t.results[0].ok && t.results[0].error.code, 'FORBIDDEN_PATH', p);
        assert.match(!t.results[0].ok ? t.results[0].error.message : '', /backup/);
        assert.equal(await errCode(k2, { op: 'rename', requestId: reqId(), rootId: top.id, path: p, newName: 'x' }), 'FORBIDDEN_PATH', p);
        const m = await ok<FsBatchResponse>(k2, { op: 'move', requestId: reqId(), rootId: top.id, paths: [p], toPath: 'Livre' });
        assert.equal(!m.results[0].ok && m.results[0].error.code, 'FORBIDDEN_PATH', p);
      }
      assert.deepEqual(k2.trashCalls, []);
      // O que está dentro do backup e ao lado dele continua valendo.
      const inner = await ok<FsBatchResponse>(k2, { op: 'move', requestId: reqId(), rootId: top.id, paths: ['Imagens/Arkivo/2026/11/foto.jpg', 'Imagens/outra.jpg'], toPath: 'Livre' });
      assert.deepEqual(inner.results.map((r) => r.ok), [true, true]);
      // A pasta do backup pode mudar a qualquer hora (Configurações): vale a de agora.
      backup = null;
      assert.equal((await ok<{ path: string }>(k2, { op: 'rename', requestId: reqId(), rootId: top.id, path: 'Imagens', newName: 'Fotos' })).path, 'Fotos');
    } finally {
      await k2.cleanup();
    }
  });

  it('[2026-11-06] permissão negada na raiz de uma unidade vira PERMISSION_DENIED com mensagem clara (não "arquivo aberto")', () => {
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const e1 = driveRootWriteError(eperm, 'C:\\', 'windows');
    assert.equal(e1?.code, 'PERMISSION_DENIED');
    assert.equal(e1?.message, DRIVE_ROOT_WRITE_MESSAGE);
    assert.equal(driveRootWriteError(eacces, 'E:\\', 'windows')?.code, 'PERMISSION_DENIED');
    // Fora da raiz (ou outro erro, ou outro sistema) vale a tradução de sempre.
    assert.equal(driveRootWriteError(eperm, 'C:\\Users\\ana', 'windows'), null);
    assert.equal(driveRootWriteError(Object.assign(new Error('x'), { code: 'ENOSPC' }), 'C:\\', 'windows'), null);
    assert.equal(driveRootWriteError(eperm, '/', 'linux'), null);
    assert.equal(fsErrorFromErrno(eperm, 'write', 'win32').code, 'BUSY');
  });

  it('erro de arquivo em uso no Lixeira vira BUSY', async () => {
    const svc = k.service as unknown as { o: { platform: { trashItem: (p: string) => Promise<void> } } };
    const orig = svc.o.platform.trashItem;
    svc.o.platform.trashItem = () =>
      Promise.reject(new Error('The process cannot access the file because it is being used by another process.'));
    try {
      const r = await ok<FsBatchResponse>(k, { op: 'trash', requestId: reqId(), rootId: root.id, paths: ['x.txt'] });
      assert.equal(!r.results[0].ok && r.results[0].error.code, 'BUSY');
    } finally {
      svc.o.platform.trashItem = orig;
    }
  });
});

describe('pastas liberadas: miniaturas (§10.4 thumb)', () => {
  it('JPEG do adaptador, cache, NO_THUMBNAIL, IS_A_DIRECTORY e fila cheia → BUSY', async () => {
    const k = await fsKit({ thumbDelayMs: 40 });
    try {
      const root = await k.addRoot('R');
      const files: Record<string, string> = { 'a.jpg': 'img', 'b.txt': 't', 'D/': '' };
      for (let i = 0; i < 40; i++) files[`f${i}.png`] = `img${i}`;
      await writeTree(root.abs, files);
      const t1 = await ok<{ mime: string; width: number; dataB64: string; etag: string }>(
        k,
        { op: 'thumb', rootId: root.id, path: 'a.jpg', size: 128 },
        REMOTE,
      );
      assert.equal(t1.mime, 'image/jpeg');
      assert.equal(t1.width, 128);
      assert.match(Buffer.from(t1.dataB64, 'base64').toString(), /^JPEG128:/);
      const t2 = await ok<{ etag: string }>(k, { op: 'thumb', rootId: root.id, path: 'a.jpg', size: 128 }, REMOTE);
      assert.equal(t2.etag, t1.etag);
      assert.equal(k.thumbCalls.n, 1, 'segunda vez veio do cache');
      assert.equal(await errCode(k, { op: 'thumb', rootId: root.id, path: 'b.txt' }), 'NO_THUMBNAIL');
      assert.equal(await errCode(k, { op: 'thumb', rootId: root.id, path: 'D' }), 'IS_A_DIRECTORY');
    } finally {
      await k.cleanup();
    }
  });

  it('até 2 gerações ao mesmo tempo e fila de 32; acima → BUSY', async () => {
    let active = 0;
    let peak = 0;
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const thumbs = new ThumbService({
      platform: {
        trashItem: () => Promise.resolve(),
        canThumbnail: () => true,
        thumbnail: async () => {
          peak = Math.max(peak, ++active);
          await gate;
          active--;
          return { jpeg: Buffer.from('jpeg'), width: 1, height: 1 };
        },
      },
    });
    const st = { mtimeMs: 1, size: 1 } as Stats;
    const all = Array.from({ length: 40 }, (_, i) => thumbs.get(`f${i}.png`, st, 128).then(() => 'ok', (e: FsOpError) => e.code));
    assert.equal(thumbs.pending, 32);
    open();
    const results = await Promise.all(all);
    assert.equal(results.filter((r) => r === 'ok').length, 34);
    assert.equal(results.filter((r) => r === 'BUSY').length, 6);
    assert.equal(peak, 2);
  });
});

describe('pastas liberadas: limites e auditoria (§10.10)', () => {
  it('20 leituras/s e 5 mudanças/s por celular → RATE_LIMITED', async () => {
    let now = 1_000_000;
    const k = await fsKit({ now: () => now, readPerSecond: 20, writePerSecond: 5 });
    try {
      const root = await k.addRoot('R');
      const reads = await Promise.all(Array.from({ length: 21 }, () => run(k, { op: 'stat', rootId: root.id, path: '' })));
      assert.equal(reads.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED').length, 1);
      // Outro celular tem a sua própria cota.
      assert.equal((await run(k, { op: 'stat', rootId: root.id, path: '' }, { phoneId: 'phone-2', via: 'lan' })).ok, true);
      const writes = [];
      for (let i = 0; i < 6; i++) writes.push(await run(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: '', name: `p${i}` }));
      assert.equal(writes.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED').length, 1);
      now += 1001;
      assert.equal((await run(k, { op: 'stat', rootId: root.id, path: '' })).ok, true);
    } finally {
      await k.cleanup();
    }
  });

  it('auditoria: mudanças registradas, navegação agrupada em browse a cada 10 min, gravada em fs-audit.json', async () => {
    let now = Date.parse('2026-11-04T12:00:00Z');
    const k = await fsKit({ now: () => now });
    try {
      const root = await k.addRoot('Fotos');
      await writeTree(root.abs, { 'a.jpg': 'a', 'b.jpg': 'b' });
      for (let i = 0; i < 5; i++) await ok(k, { op: 'list', rootId: root.id, path: '' });
      await ok(k, { op: 'stat', rootId: root.id, path: 'a.jpg' });
      await ok(k, { op: 'trash', requestId: reqId(), rootId: root.id, paths: ['a.jpg', 'b.jpg'] });
      await ok(k, { op: 'mkdir', requestId: reqId(), rootId: root.id, path: '', name: '2026' }, REMOTE);
      now += 11 * 60_000;
      await ok(k, { op: 'list', rootId: root.id, path: '' });
      const e = k.audit.entries();
      assert.deepEqual(
        e.map((x) => [x.op, x.via, x.count, x.result, x.rootLabel, x.path]),
        [
          ['browse', 'lan', 1, 'ok', null, null],
          ['mkdir', 'remote', 1, 'ok', 'Fotos', '2026'],
          ['trash', 'lan', 2, 'ok', 'Fotos', null],
          ['browse', 'lan', 6, 'ok', null, null],
        ],
      );
      assert.equal(e[0].phoneName, 'Galaxy');
      await k.audit.flush();
      const saved = JSON.parse(await fsp.readFile(path.join(k.dataDir, 'fs-audit.json'), 'utf8')) as { entries: unknown[] };
      assert.equal(saved.entries.length, 4);
    } finally {
      await k.cleanup();
    }
  });

  it('auditoria guarda no máximo N entradas e 90 dias; limpar histórico', async () => {
    const { dir, cleanup } = await fsTempDir();
    try {
      let now = Date.parse('2026-01-01T00:00:00Z');
      const log = new FsAuditLog(dir, { now: () => now, maxEntries: 3, flushDelayMs: 5 });
      const base = {
        phoneId: 'p',
        phoneName: null,
        via: 'lan' as const,
        op: 'mkdir' as const,
        rootId: 'r',
        rootLabel: 'R',
        toPath: null,
        count: 1,
        bytes: null,
        result: 'ok' as const,
      };
      for (let i = 0; i < 5; i++) log.record({ ...base, path: `p${i}` });
      assert.deepEqual(
        log.entries().map((x) => x.path),
        ['p4', 'p3', 'p2'],
      );
      now += 91 * 24 * 3600_000;
      log.record({ ...base, path: 'novo' });
      assert.deepEqual(
        log.entries().map((x) => x.path),
        ['novo'],
      );
      await log.flush();
      const again = new FsAuditLog(dir, { now: () => now });
      await again.load();
      assert.deepEqual(
        again.entries().map((x) => x.path),
        ['novo'],
      );
      await again.clear();
      assert.deepEqual(again.entries(), []);
      await sleep(20);
    } finally {
      await cleanup();
    }
  });
});
