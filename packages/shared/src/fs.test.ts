// Testes das regras de caminho, bloqueio do sistema, query canônica e validação de pedidos (contrato §10).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FS_BLOCK_MESSAGES,
  FS_MUTATING_OPS,
  FS_NAME_MAX_BYTES,
  FS_OPS,
  FS_OUTBOX_OPS,
  FS_PUSH_BLOCK_MESSAGES,
  FS_PUSH_MAX_ACTIVE,
  FS_PUSH_MAX_BYTES,
  FS_PUSH_POLL_MS,
  FS_PUSH_TTL_MS,
  FS_REMOTE_ONLY_OPS,
  canonicalFsQuery,
  checkFsName,
  compareFsEntries,
  fsBlockedReason,
  fsCollisionName,
  fsDriveLetter,
  fsListQuery,
  fsMimeFromName,
  fsParentPath,
  fsRootRejectReason,
  fsRootsOverlap,
  fsThumbCandidate,
  isAbsPathInside,
  isFsDriveRoot,
  isFsPathInside,
  joinFsPath,
  lanFsSignaturePayload,
  normalizeFsPath,
  parseFsQuery,
  parseFsRequest,
  type FsEntry,
  type FsSystemContext,
} from './fs';
import { utf8ByteLength } from './encoding';

describe('checkFsName', () => {
  test('aceita nomes comuns e normaliza para NFC', () => {
    assert.deepEqual(checkFsName('foto.jpg'), { ok: true, name: 'foto.jpg' });
    const nfd = 'Cafe\u0301.txt';
    const r = checkFsName(nfd);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.name, 'Caf\u00e9.txt');
    assert.equal(checkFsName('  espaço no começo').ok, true);
    assert.equal(checkFsName('.oculto').ok, true);
  });

  test('recusa vazio, ponto, separadores, controles e caracteres do Windows', () => {
    for (const [name, problem] of [
      ['', 'empty'],
      ['   ', 'empty'],
      ['.', 'dot'],
      ['..', 'dot'],
      ['a/b', 'invalid_char'],
      ['a\\b', 'invalid_char'],
      ['arq:stream', 'invalid_char'],
      ['C:', 'invalid_char'],
      ['tab\tx', 'invalid_char'],
      ['nul\u0000x', 'invalid_char'],
      ['a*b', 'invalid_char'],
      ['a?b', 'invalid_char'],
      ['a<b>', 'invalid_char'],
      ['a"b', 'invalid_char'],
      ['a|b', 'invalid_char'],
      ['fim.', 'trailing_dot_space'],
      ['fim ', 'trailing_dot_space'],
      ['.arkivo-fs-parciais', 'arkivo_reserved'],
      ['.ARKIVO-x', 'arkivo_reserved'],
    ] as const) {
      assert.deepEqual(checkFsName(name), { ok: false, problem }, JSON.stringify(name));
    }
  });

  test('nomes de dispositivo do Windows, com ou sem extensão', () => {
    for (const n of ['CON', 'con', 'Nul.txt', 'COM1', 'lpt9.tar.gz', 'COM¹', 'AUX .txt', 'CONIN$', 'prn']) {
      assert.deepEqual(checkFsName(n), { ok: false, problem: 'reserved' }, n);
    }
    for (const n of ['CONSOLE', 'com10', 'nulo.txt', 'auxiliar', 'LPT']) assert.equal(checkFsName(n).ok, true, n);
  });

  test('limite de 255 bytes UTF-8', () => {
    assert.equal(checkFsName('a'.repeat(FS_NAME_MAX_BYTES)).ok, true);
    assert.deepEqual(checkFsName('a'.repeat(FS_NAME_MAX_BYTES + 1)), { ok: false, problem: 'too_long' });
    // "é" = 2 bytes: 128 × 2 = 256.
    assert.deepEqual(checkFsName('é'.repeat(128)), { ok: false, problem: 'too_long' });
    assert.equal(utf8ByteLength('😀'), 4);
  });

  test('modo reference: aceita nomes que existem mas não poderiam ser criados', () => {
    for (const n of ['fim.', 'a*b', 'CON', 'x?']) assert.equal(checkFsName(n, 'reference').ok, true, n);
    for (const n of ['a/b', 'a\\b', 'a:b', '..', '', '.arkivo-parciais']) assert.equal(checkFsName(n, 'reference').ok, false, n);
  });
});

describe('normalizeFsPath', () => {
  test('raiz, caminhos válidos e NFC', () => {
    assert.deepEqual(normalizeFsPath(''), { ok: true, path: '', segments: [] });
    assert.deepEqual(normalizeFsPath('Fotos/2026/a.jpg'), { ok: true, path: 'Fotos/2026/a.jpg', segments: ['Fotos', '2026', 'a.jpg'] });
    const r = normalizeFsPath('Me\u0301xico/x');
    assert.equal(r.ok && r.path, 'M\u00e9xico/x');
  });

  test('recusa absolutos, .., barras invertidas e segmentos vazios', () => {
    for (const [p, problem] of [
      ['/etc/passwd', 'absolute'],
      ['C:/Windows', 'absolute'],
      ['c:x', 'absolute'],
      ['a\\..\\b', 'backslash'],
      ['a//b', 'empty_segment'],
      ['a/', 'empty_segment'],
      ['../x', 'dot'],
      ['a/../../x', 'dot'],
      ['a/./b', 'dot'],
      ['a/b:c', 'invalid_char'],
      ['a/.arkivo-fs-parciais/x.part', 'arkivo_reserved'],
    ] as const) {
      assert.deepEqual(normalizeFsPath(p), { ok: false, problem }, p);
    }
  });

  test('limites de tamanho e profundidade', () => {
    assert.deepEqual(normalizeFsPath(Array(65).fill('a').join('/')), { ok: false, problem: 'too_deep' });
    assert.deepEqual(normalizeFsPath(Array(6).fill('b'.repeat(200)).join('/')), { ok: false, problem: 'too_long' });
  });

  test('helpers de caminho', () => {
    assert.equal(joinFsPath('', 'a'), 'a');
    assert.equal(joinFsPath('a/b', 'c'), 'a/b/c');
    assert.equal(fsParentPath('a/b/c'), 'a/b');
    assert.equal(fsParentPath('a'), '');
    assert.equal(isFsPathInside('Fotos', 'Fotos/2026'), true);
    assert.equal(isFsPathInside('Fotos', 'Fotos'), true);
    assert.equal(isFsPathInside('Fotos', 'Fotos2'), false);
    assert.equal(isFsPathInside('fotos', 'Fotos/x', true), true);
    assert.equal(isFsPathInside('', 'qualquer'), true);
  });

  test('sufixo de colisão', () => {
    assert.equal(fsCollisionName('foto.jpg', 1), 'foto.jpg');
    assert.equal(fsCollisionName('foto.jpg', 2), 'foto (2).jpg');
    assert.equal(fsCollisionName('arquivo.tar.gz', 3), 'arquivo.tar (3).gz');
    assert.equal(fsCollisionName('.bashrc', 2), '.bashrc (2)');
    assert.equal(fsCollisionName('Pasta.v2', 2, true), 'Pasta.v2 (2)');
  });
});

describe('mime e ordenação', () => {
  test('mime pela extensão', () => {
    assert.equal(fsMimeFromName('IMG_0001.JPG'), 'image/jpeg');
    assert.equal(fsMimeFromName('video.mov'), 'video/quicktime');
    assert.equal(fsMimeFromName('sem-extensao'), 'application/octet-stream');
    assert.equal(fsMimeFromName('.bashrc'), 'application/octet-stream');
    assert.equal(fsThumbCandidate('image/png'), true);
    assert.equal(fsThumbCandidate('image/svg+xml'), false);
    assert.equal(fsThumbCandidate('text/plain'), false);
  });

  test('pastas primeiro, ordem natural, desc', () => {
    const e = (name: string, type: 'file' | 'dir', size: number | null = null, mtime = '2026-01-01T00:00:00Z'): FsEntry => ({
      name, type, size, mtime, mime: null, hidden: false, hasThumb: false,
    });
    const items = [e('foto10.jpg', 'file', 5), e('b', 'dir'), e('foto2.jpg', 'file', 50), e('Álbum', 'dir'), e('foto1.jpg', 'file', 1)];
    assert.deepEqual([...items].sort((a, b) => compareFsEntries(a, b)).map((x) => x.name), ['Álbum', 'b', 'foto1.jpg', 'foto2.jpg', 'foto10.jpg']);
    assert.deepEqual([...items].sort((a, b) => compareFsEntries(a, b, 'size', 'desc')).map((x) => x.name), ['b', 'Álbum', 'foto2.jpg', 'foto10.jpg', 'foto1.jpg']);
  });
});

describe('query canônica e texto assinado', () => {
  test('ordena chaves, codifica estrito e ignora vazios', () => {
    const q = canonicalFsQuery({ path: "Fotos/Férias (1)/it's*", rootId: 'r_abcdefgh', limit: 50, cursor: undefined, x: null });
    assert.equal(q, 'limit=50&path=Fotos%2FF%C3%A9rias%20%281%29%2Fit%27s%2A&rootId=r_abcdefgh');
  });

  test('ida e volta, inclusive quando o cliente HTTP recodifica', () => {
    const params = { rootId: 'r_abcdefgh', path: 'a b/c+d/ç' };
    const q = canonicalFsQuery(params);
    assert.deepEqual(parseFsQuery('?' + q), params);
    // Outro cliente: espaço como "+", "/" sem codificar, ordem diferente.
    const other = 'path=a+b/c%2Bd/%C3%A7&rootId=r_abcdefgh';
    assert.equal(canonicalFsQuery(parseFsQuery(other)!), q);
  });

  test('chave repetida ou percent-encoding inválido → null', () => {
    assert.equal(parseFsQuery('a=1&a=2'), null);
    assert.equal(parseFsQuery('a=%E0%A4%A'), null);
    assert.deepEqual(parseFsQuery(''), {});
  });

  test('texto assinado: formato exato', () => {
    const query = canonicalFsQuery(fsListQuery({ rootId: 'r_abcdefgh', path: 'Fotos', includeHidden: false }));
    assert.equal(query, 'includeHidden=0&path=Fotos&rootId=r_abcdefgh');
    assert.equal(
      lanFsSignaturePayload({ method: 'get', path: '/v1/fs/list', query, ts: 1700000000000, nonce: 'n'.repeat(22) }),
      `ARKIVO-FS-1\nGET\n/v1/fs/list\n${query}\n1700000000000\n${'n'.repeat(22)}\n`,
    );
    assert.equal(
      lanFsSignaturePayload({ method: 'POST', path: '/v1/fs/trash', query: '', ts: '1', nonce: 'x', bodySha256: 'AB' }),
      'ARKIVO-FS-1\nPOST\n/v1/fs/trash\n\n1\nx\nab',
    );
  });
});

describe('bloqueio do sistema', () => {
  const win: FsSystemContext = {
    platform: 'windows',
    home: 'C:\\Users\\ana',
    systemDrive: 'C:',
    windowsDir: 'C:\\WINDOWS',
    programFiles: ['C:\\Program Files', 'C:\\Program Files (x86)'],
    programData: 'C:\\ProgramData',
    extraBlocked: ['C:\\Users\\ana\\AppData\\Roaming\\Arkivo'],
  };
  const mac: FsSystemContext = { platform: 'macos', home: '/Users/ana' };
  const linux: FsSystemContext = { platform: 'linux', home: '/home/ana' };

  test('Windows: pastas do sistema, AppData, lixeira e arquivos de paginação', () => {
    for (const p of [
      'C:\\Windows',
      'c:\\windows\\system32\\drivers',
      'C:\\Program Files\\App',
      'C:\\Program Files (x86)',
      'C:\\ProgramData\\x',
      'C:\\Users\\ana\\AppData\\Local',
      'C:\\Users\\outro\\AppData',
      'C:\\Users\\Default',
      'C:\\Users\\ana\\NTUSER.DAT',
      'D:\\$RECYCLE.BIN\\S-1-5',
      'E:\\System Volume Information',
      'D:\\Program Files\\Jogo',
      'C:\\pagefile.sys',
      '\\\\?\\C:\\Windows\\x',
      'C:/Windows/x',
    ]) {
      assert.notEqual(fsBlockedReason(p, win), null, p);
    }
    assert.equal(fsBlockedReason('C:\\Users\\ana\\AppData', win), 'app-data');
    assert.equal(fsBlockedReason('C:\\Users\\ana\\.ssh\\id_rsa', win), 'credentials');
    assert.equal(fsBlockedReason('D:\\Fotos\\.arkivo-fs-parciais\\x.part', win), 'arkivo-internal');
  });

  test('Windows: pastas do usuário e outras unidades ficam liberadas', () => {
    for (const p of ['C:\\Users\\ana\\Documents', 'C:\\Users\\ana', 'C:\\Fotos', 'D:\\', 'E:\\Backup\\Windows', 'D:\\pagefile.sys\\x', '\\\\nas\\fotos\\2026']) {
      assert.equal(fsBlockedReason(p, win), null, p);
    }
  });

  test('raiz liberada [2026-11-06]: C:\\ inteiro sim no Windows; / não no macOS nem no Linux; D:\\ e HD externo sim', () => {
    assert.equal(fsRootRejectReason('C:\\', win), null);
    assert.equal(fsRootRejectReason('c:', win), null);
    assert.equal(fsRootRejectReason('\\\\?\\C:\\', win), null);
    assert.equal(fsRootRejectReason('D:\\', win), null);
    assert.equal(fsRootRejectReason('C:\\Windows', win), 'system');
    assert.equal(fsRootRejectReason('/', mac), 'filesystem-root');
    assert.equal(fsRootRejectReason('/Volumes/HD Externo', mac), null);
    assert.equal(fsRootRejectReason('/', linux), 'filesystem-root');
    assert.equal(fsRootRejectReason('/media/ana/HD', linux), null);
    assert.equal(fsRootRejectReason('relativo\\x', win), 'system');
    // A unidade do sistema em outra letra (`%SystemDrive%` = D:) também pode.
    assert.equal(fsRootRejectReason('D:\\', { ...win, systemDrive: 'D:' }), null);
  });

  test('com C:\\ liberado inteiro, o que fica bloqueado por dentro (sistema, programas, AppData, outros perfis, credenciais, Arkivo)', () => {
    const blocked: [string, string][] = [
      ['C:\\Windows', 'system'],
      ['C:\\Windows\\System32\\config\\SAM', 'system'],
      ['C:\\Program Files', 'system'],
      ['C:\\Program Files (x86)\\Steam', 'system'],
      ['C:\\ProgramData', 'system'],
      ['C:\\$Recycle.Bin', 'system'],
      ['C:\\$Recycle.Bin\\S-1-5-21\\$R123.jpg', 'system'],
      ['C:\\System Volume Information', 'system'],
      ['C:\\Recovery', 'system'],
      ['C:\\Config.Msi', 'system'],
      ['C:\\PerfLogs', 'system'],
      ['C:\\OneDriveTemp', 'system'],
      ['C:\\Documents and Settings', 'system'],
      ['C:\\Arquivos de Programas', 'system'],
      ['C:\\inetpub\\wwwroot', 'system'],
      ['C:\\pagefile.sys', 'system'],
      ['C:\\hiberfil.sys', 'system'],
      ['C:\\swapfile.sys', 'system'],
      ['C:\\DumpStack.log.tmp', 'system'],
      ['C:\\bootmgr', 'system'],
      ['C:\\Users\\Default', 'system'],
      ['C:\\Users\\Default User', 'system'],
      ['C:\\Users\\All Users', 'system'],
      ['C:\\Users\\ana\\NTUSER.DAT', 'system'],
      ['C:\\Users\\ana\\AppData', 'app-data'],
      ['C:\\Users\\ana\\AppData\\Roaming\\Arkivo\\config.json', 'arkivo-internal'],
      ['C:\\Users\\outro', 'other-profile'],
      ['C:\\Users\\Outro\\Documents\\senha.txt', 'other-profile'],
      ['C:\\Users\\desktop.ini', 'other-profile'],
      ['C:\\Users\\ana\\.ssh', 'credentials'],
      ['C:\\Dados\\.aws\\credentials', 'credentials'],
      ['C:\\.arkivo-fs-parciais', 'arkivo-internal'],
      ['C:\\.arkivo-fs-parciais\\x.part', 'arkivo-internal'],
    ];
    for (const [p, reason] of blocked) assert.equal(fsBlockedReason(p, win), reason, p);
    const free = ['C:\\', 'C:\\Users', 'C:\\Users\\ana', 'C:\\Users\\ANA\\Documents', 'C:\\Users\\Public\\Pictures', 'C:\\Fotos', 'C:\\Git\\projeto', 'C:\\pagefile.sys.txt'];
    for (const p of free) assert.equal(fsBlockedReason(p, win), null, p);
    // Os outros perfis são os da pasta de perfis do usuário; um "Users" em outra unidade é pasta comum.
    assert.equal(fsBlockedReason('D:\\Users\\outro', win), null);
    // Sem `home` dentro de uma pasta `Users` (testes, perfil em outro lugar), não há "outros perfis" a deduzir.
    assert.equal(fsBlockedReason('D:\\Perfis\\outro', { ...win, home: 'D:\\Perfis\\ana' }), null);
    assert.equal(FS_BLOCK_MESSAGES['other-profile'], 'Esta pasta é de outro usuário deste PC e não pode ser liberada.');
  });

  test('raiz de unidade e letra da unidade', () => {
    for (const p of ['C:\\', 'c:', 'C:/', '\\\\?\\E:\\']) assert.equal(isFsDriveRoot(p, 'windows'), true, p);
    for (const p of ['C:\\Users', '\\\\nas\\fotos', 'relativo']) assert.equal(isFsDriveRoot(p, 'windows'), false, p);
    assert.equal(isFsDriveRoot('/', 'linux'), false);
    assert.equal(fsDriveLetter('e:\\DCIM', 'windows'), 'E:');
    assert.equal(fsDriveLetter('\\\\nas\\fotos', 'windows'), null);
    assert.equal(fsDriveLetter('/Volumes/HD', 'macos'), null);
  });

  test('macOS e Linux', () => {
    for (const p of ['/System/Library', '/Library', '/Applications/App.app', '/Users/ana/Library/Mail', '/Volumes/HD/.Trashes', '/private/etc'])
      assert.notEqual(fsBlockedReason(p, mac), null, p);
    assert.equal(fsBlockedReason('/users/ana/library', mac), 'app-data');
    for (const p of ['/Users/ana/Pictures', '/Volumes/HD']) assert.equal(fsBlockedReason(p, mac), null, p);
    for (const p of ['/etc', '/usr/share', '/home/ana/.config/Arkivo', '/home/ana/.local/share', '/media/x/.Trash-1000', '/proc/1'])
      assert.notEqual(fsBlockedReason(p, linux), null, p);
    // Linux diferencia maiúsculas: /Etc não é /etc.
    for (const p of ['/home/ana/Imagens', '/mnt/hd/Etc', '/srvdados']) assert.equal(fsBlockedReason(p, linux), null, p);
  });

  test('dentro da raiz e sobreposição', () => {
    assert.equal(isAbsPathInside('D:\\Fotos', 'd:\\fotos\\2026', 'windows'), true);
    assert.equal(isAbsPathInside('D:\\Fotos', 'D:\\Fotos2', 'windows'), false);
    assert.equal(isAbsPathInside('/home/ana/Fotos', '/home/ana/fotos/x', 'linux'), false);
    assert.equal(isAbsPathInside('/Users/ana/Fotos', '/users/ana/fotos/x', 'macos'), true);
    assert.equal(isAbsPathInside('D:\\Fotos', 'D:\\Fotos\\..\\Outra', 'windows'), false);
    assert.equal(fsRootsOverlap('D:\\Fotos', 'D:\\Fotos\\2026', 'windows'), true);
    assert.equal(fsRootsOverlap('D:\\Fotos\\2026', 'D:\\Fotos', 'windows'), true);
    assert.equal(fsRootsOverlap('D:\\Fotos', 'E:\\Fotos', 'windows'), false);
    // Unidade inteira sobrepõe tudo o que está nela, e só nela.
    assert.equal(fsRootsOverlap('C:\\', 'C:\\Users\\ana\\Fotos', 'windows'), true);
    assert.equal(fsRootsOverlap('c:\\Users\\ana', 'C:\\', 'windows'), true);
    assert.equal(fsRootsOverlap('C:\\', 'C:', 'windows'), true);
    assert.equal(fsRootsOverlap('C:\\', 'D:\\', 'windows'), false);
    assert.equal(fsRootsOverlap('C:\\', 'D:\\Fotos', 'windows'), false);
    assert.equal(fsRootsOverlap('C:\\', '\\\\nas\\fotos', 'windows'), false);
  });
});

describe('parseFsRequest', () => {
  const rid = 'r_abcdefgh';
  const req = 'q'.repeat(22);

  test('list a partir da query da LAN (texto) e do envelope (tipos JSON)', () => {
    assert.deepEqual(parseFsRequest({ op: 'list', rootId: rid, path: 'Fotos', limit: '50', includeHidden: '1', sort: 'mtime', order: 'desc' }), {
      ok: true,
      request: { op: 'list', rootId: rid, path: 'Fotos', limit: 50, includeHidden: true, sort: 'mtime', order: 'desc' },
    });
    assert.deepEqual(parseFsRequest({ op: 'list', rootId: rid }), { ok: true, request: { op: 'list', rootId: rid, path: '' } });
  });

  test('erros com código certo', () => {
    const code = (x: unknown) => {
      const r = parseFsRequest(x);
      return r.ok ? null : r.error.code;
    };
    assert.equal(code(null), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'formatar' }), 'UNSUPPORTED_OP');
    assert.equal(code({ op: 'list', rootId: 'x' }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'list', rootId: rid, path: '../x' }), 'FORBIDDEN_PATH');
    assert.equal(code({ op: 'list', rootId: rid, limit: 501 }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'thumb', rootId: rid, path: 'a.jpg', size: 300 }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'mkdir', requestId: req, rootId: rid, path: '', name: 'CON' }), 'INVALID_NAME');
    assert.equal(code({ op: 'mkdir', rootId: rid, path: '', name: 'x' }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'rename', requestId: req, rootId: rid, path: '', newName: 'x' }), 'FORBIDDEN_PATH');
    assert.equal(code({ op: 'trash', requestId: req, rootId: rid, paths: [] }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'trash', requestId: req, rootId: rid, paths: [''] }), 'FORBIDDEN_PATH');
    assert.equal(code({ op: 'trash', requestId: req, rootId: rid, paths: ['a', 'a'] }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'trash', requestId: req, rootId: rid, paths: Array(101).fill(0).map((_, i) => `f${i}`) }), 'VALIDATION_ERROR');
    assert.equal(code({ op: 'move', requestId: req, rootId: rid, paths: ['a'], toPath: 'b', onConflict: 'replace' }), 'VALIDATION_ERROR');
  });

  test('move, trash e upload válidos', () => {
    assert.deepEqual(parseFsRequest({ op: 'move', requestId: req, rootId: rid, paths: ['a', 'b/c'], toPath: 'd', toRootId: 'r_zzzzzzzz', onConflict: 'rename' }), {
      ok: true,
      request: { op: 'move', requestId: req, rootId: rid, paths: ['a', 'b/c'], toPath: 'd', toRootId: 'r_zzzzzzzz', onConflict: 'rename' },
    });
    const up = parseFsRequest({
      op: 'upload', requestId: req, rootId: rid, path: 'Fotos', name: 'a.jpg', blobId: '6650f0c1a2b3c4d5e6f70809',
      blobSalt: 's'.repeat(22), size: 10, sha256: 'A'.repeat(64),
    });
    assert.equal(up.ok && up.request.op === 'upload' && up.request.sha256, 'a'.repeat(64));
  });

  test('§11: as operações da caixa de saída só levam `id`', () => {
    const id = 'i'.repeat(22);
    assert.deepEqual(parseFsRequest({ op: 'outboxList', id }), { ok: true, request: { op: 'outboxList' } });
    for (const op of ['outboxDownload', 'outboxDone', 'outboxDecline'] as const) {
      assert.deepEqual(parseFsRequest({ op, id, path: 'C:/Windows/system.ini', rootId: rid }), { ok: true, request: { op, id } });
      for (const bad of [undefined, 'curto', '../../etc/passwd', 'x'.repeat(65), 42]) {
        const r = parseFsRequest({ op, id: bad });
        assert.equal(r.ok ? 'ok' : r.error.code, 'VALIDATION_ERROR', String(bad));
      }
    }
  });

  test('§11: a caixa de saída independe do interruptor, e só o download é exclusivo do remoto', () => {
    assert.deepEqual(FS_OUTBOX_OPS, ['outboxList', 'outboxDownload', 'outboxDone', 'outboxDecline']);
    for (const op of FS_OUTBOX_OPS) assert.ok(FS_OPS.includes(op));
    assert.ok(FS_REMOTE_ONLY_OPS.includes('outboxDownload'));
    assert.ok(!FS_REMOTE_ONLY_OPS.includes('outboxList'));
    assert.ok(!FS_MUTATING_OPS.includes('outboxDone'), 'não muda o disco, então não precisa de `requestId`');
  });
});

describe('§11 enviar para o celular', () => {
  test('a mensagem de recusa fala de arquivo, não de pasta liberada', () => {
    for (const reason of ['system', 'app-data', 'other-profile', 'credentials', 'arkivo-internal'] as const) {
      assert.match(FS_PUSH_BLOCK_MESSAGES[reason], /arquivo/i);
      assert.doesNotMatch(FS_PUSH_BLOCK_MESSAGES[reason], /liberad/);
    }
  });

  test('limites do contrato: 7 dias, 200 ativos, 2 GiB, consulta a cada 30 s', () => {
    assert.equal(FS_PUSH_TTL_MS, 7 * 86_400_000);
    assert.equal(FS_PUSH_MAX_ACTIVE, 200);
    assert.equal(FS_PUSH_MAX_BYTES, 2 ** 31);
    assert.equal(FS_PUSH_POLL_MS, 30_000);
  });
});
