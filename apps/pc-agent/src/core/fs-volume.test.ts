// Pastas liberadas: detecção da Lixeira por volume (contrato §10.11), com o comando do sistema injetado.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDriveViews, findDrive } from './fs-drives';
import { NonceCache } from './fs-lan-auth';
import { ConcurrencyLimiter, IdempotencyCache, RateLimiter } from './fs-limits';
import {
  SystemVolumeProbe,
  driveKindLabel,
  findMount,
  mountHasTrash,
  parseMacMounts,
  parseProcMounts,
  parseWindowsDrives,
  parseWindowsDriveTypes,
  posixDriveCandidates,
  posixDriveLabel,
  type DriveKind,
} from './fs-volume';

describe('volumes e Lixeira (§10.11)', () => {
  it('Windows: só unidade Fixed tem Lixeira; removível, rede e compartilhamento UNC não; na dúvida, não', async () => {
    const calls: string[][] = [];
    const out = 'C:\\|Fixed\r\nD:\\|Fixed\r\nE:\\|Removable\r\nZ:\\|Network\r\nF:\\|CDRom\r\n';
    const probe = new SystemVolumeProbe({ platform: 'windows', exec: async (f, a) => (calls.push([f, ...a]), out) });
    assert.deepEqual(await probe.info('D:\\Fotos'), { drive: 'D:', trashAvailable: true });
    assert.deepEqual(await probe.info('e:\\DCIM'), { drive: 'E:', trashAvailable: false });
    assert.deepEqual(await probe.info('Z:\\'), { drive: 'Z:', trashAvailable: false });
    assert.deepEqual(await probe.info('\\\\nas\\fotos\\2026'), { drive: '\\\\nas\\fotos', trashAvailable: false });
    assert.equal(calls.length, 1, 'cache por letra');
    assert.equal(calls[0][0], 'powershell.exe');
    // Unidade desconhecida: consulta de novo uma vez e, sem resposta, recusa.
    assert.deepEqual(await probe.info('Q:\\x'), { drive: 'Q:', trashAvailable: false });
    assert.equal(calls.length, 2);
    const broken = new SystemVolumeProbe({ platform: 'windows', exec: () => Promise.reject(new Error('sem powershell')) });
    assert.equal((await broken.info('C:\\x')).trashAvailable, false);
    assert.deepEqual([...parseWindowsDriveTypes('C:\\|Fixed\nlixo\n').entries()], [['c', 'Fixed']]);
  });

  it('Linux: /proc/self/mounts, rede e FUSE desconhecido sem Lixeira; nome do volume em /media', async () => {
    const mounts = parseProcMounts(
      [
        '/dev/sda1 / ext4 rw 0 0',
        '/dev/sdb1 /media/ana/HD\\040Externo exfat rw 0 0',
        '//nas/fotos /mnt/nas cifs rw 0 0',
        'x /home/ana/remoto fuse.sshfs rw 0 0',
        '/dev/sdc1 /media/ana/NTFS fuseblk rw 0 0',
      ].join('\n'),
    );
    assert.equal(findMount(mounts, '/media/ana/HD Externo/DCIM')?.fsType, 'exfat');
    assert.equal(posixDriveLabel('/media/ana/HD Externo'), 'HD Externo');
    assert.equal(mountHasTrash(findMount(mounts, '/mnt/nas/2026')!), false);
    assert.equal(mountHasTrash(findMount(mounts, '/home/ana/remoto/x')!), false);
    assert.equal(mountHasTrash(findMount(mounts, '/media/ana/NTFS/x')!), true);
    assert.equal(mountHasTrash(findMount(mounts, '/home/ana/Fotos')!), true);
    const probe = new SystemVolumeProbe({
      platform: 'linux',
      readFile: async () => '/dev/sda1 / ext4 rw 0 0\n//nas/x /mnt/nas cifs rw 0 0\n',
    });
    assert.deepEqual(await probe.info('/mnt/nas/a'), { drive: 'nas', trashAvailable: false });
    assert.deepEqual(await probe.info('/home/ana'), { drive: null, trashAvailable: true });
  });

  it('macOS: saída do mount; volume sem "local" ou smbfs sem Lixeira', async () => {
    const text = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk4s1 on /Volumes/Fotos (exfat, local, nodev, nosuid, noowners)',
      '//ana@nas._smb._tcp.local/casa on /Volumes/casa (smbfs, nodev, nosuid, mounted by ana)',
    ].join('\n');
    const m = parseMacMounts(text);
    assert.equal(m.length, 3);
    const probe = new SystemVolumeProbe({ platform: 'macos', exec: async () => text });
    assert.deepEqual(await probe.info('/Volumes/Fotos/2026'), { drive: 'Fotos', trashAvailable: true });
    assert.deepEqual(await probe.info('/Volumes/casa/x'), { drive: 'casa', trashAvailable: false });
  });
});

describe('[2026-11-06] unidades deste PC (§10.13)', () => {
  const OUT = [
    '\uFEFFA:\\|Removable|False|||',
    'E:\\|Removable|True|32000000000|1000|PEN|DRIVE',
    'C:\\|Fixed|True|511080132608|199810002944|',
    'Z:\\|Network|True|2000|500|Família',
    'D:\\|CDRom|False|||',
    'F:\\|Ram|True|10|5|RAMDISK',
    'C:\\|Fixed|True|1|1|repetida',
    'lixo sem formato',
    'G:\\|Fixed|True|abc||Dados',
  ].join('\r\n');

  it('Windows: tipos, ignora as que não estão prontas, sistema primeiro e depois por letra', () => {
    const list = parseWindowsDrives(OUT, 'C:');
    assert.deepEqual(
      list.map((d) => [d.id, d.root, d.name, d.kind, d.volumeLabel, d.trashAvailable]),
      [
        ['C', 'C:\\', 'C:', 'fixed', null, true],
        ['E', 'E:\\', 'E:', 'removable', 'PEN|DRIVE', false],
        ['F', 'F:\\', 'F:', 'other', 'RAMDISK', false],
        ['G', 'G:\\', 'G:', 'fixed', 'Dados', true],
        ['Z', 'Z:\\', 'Z:', 'network', 'Família', false],
      ],
    );
    assert.deepEqual([list[0].totalBytes, list[0].freeBytes], [511080132608, 199810002944]);
    assert.deepEqual([list[3].totalBytes, list[3].freeBytes], [null, null], 'número inválido vira null');
    // Sem saber a unidade do sistema: só por letra.
    assert.deepEqual(parseWindowsDrives(OUT).map((d) => d.id), ['C', 'E', 'F', 'G', 'Z']);
    assert.deepEqual(parseWindowsDrives('D:\\|Fixed|True|1|1|\r\nC:\\|Fixed|True|1|1|', 'D:').map((d) => d.id), ['D', 'C']);
    assert.deepEqual(['fixed', 'removable', 'network', 'cdrom', 'other'].map((k) => driveKindLabel(k as DriveKind)), [
      'Disco interno',
      'Pen drive / HD externo',
      'Unidade de rede',
      'CD/DVD',
      'Outra unidade',
    ]);
  });

  it('Windows: listDrives roda o PowerShell sem cache e atualiza o tipo usado pela Lixeira (pen drive novo)', async () => {
    const calls: string[][] = [];
    let out = 'C:\\|Fixed|True|10|5|\r\n';
    const probe = new SystemVolumeProbe({ platform: 'windows', systemDrive: 'C:', exec: (f, a) => (calls.push([f, ...a]), Promise.resolve(out)) });
    assert.deepEqual((await probe.listDrives()).map((d) => d.id), ['C']);
    out = 'C:\\|Fixed|True|10|5|\r\nE:\\|Removable|True|10|5|KINGSTON\r\n';
    const two = await probe.listDrives();
    assert.deepEqual(two.map((d) => [d.id, d.volumeLabel]), [['C', null], ['E', 'KINGSTON']]);
    assert.equal(calls.length, 2, 'sem cache: um pen drive conectado aparece na próxima consulta');
    assert.match(calls[0].join(' '), /DriveInfo.*IsReady.*AvailableFreeSpace.*VolumeLabel/);
    // `info` (Lixeira) aproveita o tipo que a lista acabou de ver, sem rodar o PowerShell de novo.
    assert.deepEqual(await probe.info('E:\\DCIM'), { drive: 'E:', trashAvailable: false });
    assert.equal(calls.length, 2);
    const broken = new SystemVolumeProbe({ platform: 'windows', exec: () => Promise.reject(new Error('sem powershell')) });
    assert.deepEqual(await broken.listDrives(), []);
  });

  it('macOS/Linux: volumes montados em /Volumes, /media e /mnt, com espaço; o disco do sistema fica de fora', async () => {
    const text = [
      '/dev/sda1 / ext4 rw 0 0',
      '/dev/sdb1 /media/ana/HD\\040Externo exfat rw 0 0',
      '//nas/fotos /mnt/nas cifs rw 0 0',
      'tmpfs /run/user/1000 tmpfs rw 0 0',
      'x /media/ana/sumiu ext4 rw 0 0',
      'systemd-1 /mnt/auto autofs rw 0 0',
    ].join('\n');
    const probe = new SystemVolumeProbe({
      platform: 'linux',
      readFile: () => Promise.resolve(text),
      statfs: (mp) => Promise.resolve(mp.endsWith('sumiu') ? null : { totalBytes: 100, freeBytes: 40 }),
    });
    assert.deepEqual(
      (await probe.listDrives()).map((d) => [d.id, d.name, d.kind, d.trashAvailable, d.freeBytes]),
      [
        ['/media/ana/HD Externo', 'HD Externo', 'removable', true, 40],
        ['/mnt/nas', 'nas', 'network', false, 40],
      ],
    );
    assert.deepEqual(posixDriveCandidates(parseProcMounts('/dev/x /Volumes/HD apfs rw 0 0\n/dev/x /Volumes/HD apfs rw 0 0')).length, 1);
  });

  it('tela: marca a unidade liberada inteira e conta as pastas liberadas dentro de cada uma', () => {
    const drives = parseWindowsDrives('C:\\|Fixed|True|10|5|\r\nE:\\|Removable|True|10|5|\r\nX:\\|Fixed|True|10|5|', 'C:');
    const root = (id: string, absPath: string) => ({ id, label: id, absPath, addedAt: '' });
    const roots = [root('r1', 'C:\\Users\\ana\\Fotos'), root('r2', 'c:\\Dados'), root('r3', 'E:\\'), root('r4', 'C:\\SubstX')];
    // `X:` é um `subst` para `C:\SubstX`: o `realpath` da raiz da unidade decide.
    const views = buildDriveViews(drives, roots, { platform: 'windows', systemDrive: 'C:', reals: new Map([['X', 'C:\\SubstX']]) });
    assert.deepEqual(
      views.map((v) => [v.id, v.label, v.system, v.canAddWhole, v.wholeRootId, v.rootsInside, v.kindLabel]),
      [
        ['C', 'Disco local (C:)', true, true, null, 3, 'Disco interno'],
        ['E', 'Pen drive (E:)', false, true, 'r3', 0, 'Pen drive / HD externo'],
        ['X', 'Disco local (X:)', false, true, 'r4', 0, 'Disco interno'],
      ],
    );
    const mac = buildDriveViews([{ id: '/Volumes/HD', root: '/Volumes/HD', name: 'HD', volumeLabel: null, kind: 'removable', totalBytes: 1, freeBytes: 1, trashAvailable: true }], [root('m', '/Volumes/HD/Fotos')], { platform: 'macos' });
    assert.deepEqual([mac[0].canAddWhole, mac[0].system, mac[0].rootsInside, mac[0].label], [false, false, 1, 'HD']);
    // O renderer só manda o `id`; o caminho vem sempre da lista.
    assert.equal(findDrive(drives, 'E')?.root, 'E:\\');
    for (const bad of ['E:\\', 'C:\\Windows', '../x', '', 7, null]) assert.equal(findDrive(drives, bad), null, String(bad));
  });
});

describe('limites, nonce e idempotência (§10.4, §10.5, §10.10)', () => {
  it('RateLimiter: janela de 1 s por chave', () => {
    let t = 0;
    const r = new RateLimiter(2, () => t);
    assert.deepEqual([r.take('a'), r.take('a'), r.take('a'), r.take('b')], [true, true, false, true]);
    t = 1000;
    assert.equal(r.take('a'), true);
  });

  it('ConcurrencyLimiter: máximo por chave, liberar duas vezes não conta', () => {
    const c = new ConcurrencyLimiter(2);
    const a = c.acquire('p')!;
    const b = c.acquire('p')!;
    assert.equal(c.acquire('p'), null);
    a();
    a();
    assert.equal(c.count('p'), 1);
    assert.ok(c.acquire('p'));
    b();
  });

  it('NonceCache: repetido recusado dentro de 240 s, aceito depois', () => {
    const n = new NonceCache(240_000);
    assert.equal(n.accept('x', 0), true);
    assert.equal(n.accept('x', 239_000), false);
    assert.equal(n.accept('x', 241_000), true);
  });

  it('IdempotencyCache: guarda por 10 min; erros passageiros não ficam guardados', async () => {
    let t = 0;
    const c = new IdempotencyCache(600_000, () => t);
    let runs = 0;
    const fn = async () => (runs++, { ok: true as const, data: runs });
    assert.deepEqual(await c.run('k', fn), { ok: true, data: 1 });
    assert.deepEqual(await c.run('k', fn), { ok: true, data: 1 });
    t = 600_001;
    assert.deepEqual(await c.run('k', fn), { ok: true, data: 2 });
    const busy = async () => ({ ok: false as const, error: { code: 'BUSY' as const, message: 'x' } });
    await c.run('b', busy);
    assert.deepEqual(await c.run('b', fn), { ok: true, data: 3 });
  });
});
