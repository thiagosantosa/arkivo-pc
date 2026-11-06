// Enviar para o celular (contrato §11): caixa de saída contra arquivos reais, sem Electron. As vias entram depois, no
// despachante (`FsService.execute`) e nas rotas da LAN; o caminho remoto completo está em tests/integration/fs-push-e2e.
import assert from 'node:assert/strict';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CAPABILITIES,
  FS_LAN_ROUTES,
  FS_PUSH_MAX_ACTIVE,
  FS_PUSH_TTL_MS,
  canonicalFsQuery,
  parseFsRequest,
  randomFsId,
  sha256Hex,
  signLanFsRequest,
  utf8Encode,
  type FsDownloadPrepared,
  type FsOutboxItemResponse,
  type FsOutboxListResponse,
  type FsRequest,
} from '@arkivo/shared';
import { FsLanRoutes } from './fs-lan';
import { FS_OUTBOX_FILE, FS_OUTBOX_IDLE_MS, FsOutbox } from './fs-outbox';
import { buildFsSystemContext } from './fs-roots';
import { FsOpError } from './fs-errors';
import { LanServer } from './lan-server';
import { Storage } from './storage';
import { fsKit, fsTempDir, hostFsPlatform, newPairKey, sha256, type FsKit } from './test-helpers';

const A = { id: 'phone-a', name: 'Celular A' };
const B = { id: 'phone-b', name: 'Celular B' };

interface Ctx {
  dir: string;
  dataDir: string;
  files: string;
  now: { t: number };
  make: (o?: { maxActive?: number; maxBytes?: number }) => FsOutbox;
  write: (name: string, content?: string | Buffer) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const { dir, cleanup } = await fsTempDir('outbox-');
  const dataDir = path.join(dir, 'data');
  const files = path.join(dir, 'arquivos');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(files, { recursive: true });
  const now = { t: Date.UTC(2026, 10, 4, 12) };
  const ctx = buildFsSystemContext({ platform: hostFsPlatform, home: path.join(dir, 'home'), env: {}, extraBlocked: [dataDir] });
  return {
    dir,
    dataDir,
    files,
    now,
    make: (o = {}) => new FsOutbox({ dataDir, ctx, now: () => now.t, ...o }),
    write: async (name, content = 'conteúdo') => {
      const abs = path.join(files, name);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content);
      return abs;
    },
    cleanup,
  };
}

const codeOf = (code: string) => (e: unknown) => {
  assert.ok(e instanceof FsOpError, String(e));
  assert.equal(e.code, code);
  return true;
};

describe('caixa de saída (§11)', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });
  afterEach(async () => {
    await c.cleanup();
  });

  it('põe o arquivo na fila e mostra só o que o celular pode ver: nada de caminho absoluto', async () => {
    const box = c.make();
    const file = await c.write('foto.jpg', 'abc');
    const r = await box.add([file], A);
    assert.deepEqual(r.rejected, []);
    assert.equal(r.added[0].state, 'waiting');
    assert.equal(r.added[0].phoneId, A.id);
    const [item] = await box.listFor(A.id);
    assert.equal(item.name, 'foto.jpg');
    assert.equal(item.size, 3);
    assert.equal(item.mime, 'image/jpeg');
    assert.ok(!JSON.stringify(item).includes(c.files), 'o caminho absoluto não vai ao celular');
    assert.equal(Date.parse(item.expiresAt) - Date.parse(item.createdAt), FS_PUSH_TTL_MS);
  });

  it('persiste em outbox.json e volta depois de reiniciar; quem baixava volta a esperar', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    const [added] = (await box.add([file], A)).added;
    await box.beginDelivery(A.id, added.id, 'lan');
    const stored = JSON.parse(await fsp.readFile(path.join(c.dataDir, FS_OUTBOX_FILE), 'utf8')) as {
      items: { state: string; absPath: string }[];
    };
    assert.equal(stored.items[0].state, 'downloading');
    assert.ok(stored.items[0].absPath.endsWith('a.txt'));

    const again = c.make();
    await again.load();
    const [item] = await again.listFor(A.id);
    assert.equal(item.id, added.id);
    assert.equal(item.state, 'waiting');
    const file2 = await again.beginDelivery(A.id, added.id, 'remote');
    assert.equal(sha256(await fsp.readFile(file2.abs)), sha256('conteúdo'));
  });

  it('arquivo corrompido em disco vira lista vazia, sem derrubar o PC', async () => {
    await fsp.writeFile(path.join(c.dataDir, FS_OUTBOX_FILE), '{ não é json');
    const box = c.make();
    await box.load();
    assert.deepEqual(box.views(), []);
  });

  it('expira em 7 dias, inclusive depois de reiniciar, e o arquivo original continua lá', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    const b2 = await c.write('b.txt');
    const [first, second] = (await box.add([file, b2], A)).added;
    c.now.t += FS_PUSH_TTL_MS - 1000;
    assert.equal((await box.listFor(A.id)).length, 2, 'ainda no prazo');
    c.now.t += 1000;
    await box.tick();
    assert.equal(box.views().find((v) => v.id === first.id)?.state, 'expired');
    assert.deepEqual(await box.listFor(A.id), []);
    await assert.rejects(box.beginDelivery(A.id, first.id, 'lan'), codeOf('NOT_FOUND'));
    assert.ok(existsSync(file), 'expirar não apaga o original');

    const reloaded = c.make();
    await reloaded.load();
    assert.equal(reloaded.views().find((v) => v.id === second.id)?.state, 'expired');
  });

  it('limite de itens ativos: o que passa é recusado, e o que já terminou libera vaga', async () => {
    const box = c.make({ maxActive: 2 });
    const paths = await Promise.all(['a', 'b', 'c'].map((n) => c.write(`${n}.txt`)));
    const r = await box.add(paths, A);
    assert.equal(r.added.length, 2);
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /Limite de 2/);
    await box.done(A.id, r.added[0].id);
    assert.equal((await box.add([paths[2]], A)).added.length, 1);
    assert.equal(FS_PUSH_MAX_ACTIVE, 200, 'o padrão do contrato');
  });

  it('recusa o que passa do limite de tamanho, contando a cifra dos blobs', async () => {
    const box = c.make({ maxBytes: 1024 });
    const big = await c.write('grande.bin', Buffer.alloc(1024));
    const r = await box.add([big], A);
    assert.equal(r.added.length, 0);
    assert.match(r.rejected[0].reason, /passa de 2 GB/);
  });

  it('recusa pastas, caminho relativo, inexistente, repetido e o que é bloqueado, com a mensagem de cada um', async () => {
    const box = c.make();
    const ok = await c.write('ok.txt');
    await fsp.mkdir(path.join(c.files, 'pasta'));
    const ssh = await c.write('.ssh/id_rsa', 'chave');
    const interno = path.join(c.dataDir, 'config.json');
    await fsp.writeFile(interno, '{}');
    const reservado = await c.write('.arkivo-teste.txt');
    const r = await box.add(
      [ok, ok, path.join(c.files, 'pasta'), 'relativo.txt', path.join(c.files, 'nao-existe'), ssh, interno, reservado, 42],
      A,
    );
    assert.equal(r.added.length, 1);
    const reasons = r.rejected.map((x) => x.reason);
    assert.match(reasons[0], /já está esperando/);
    assert.match(reasons[1], /Pastas ainda não/);
    assert.match(reasons[2], /Caminho inválido/);
    assert.match(reasons[3], /Não foi possível abrir/);
    assert.match(reasons[4], /chaves e senhas/);
    assert.match(reasons[5], /uso interno/);
    assert.match(reasons[6], /uso interno/);
    assert.match(reasons[7], /Caminho inválido/);
    assert.equal(r.rejected[4].name, 'id_rsa', 'o motivo vem com o nome, nunca com o caminho');
  });

  it('recusa links simbólicos, mesmo apontando para um arquivo permitido', async (t) => {
    const box = c.make();
    const real = await c.write('real.txt');
    const link = path.join(c.files, 'atalho.txt');
    try {
      await fsp.symlink(real, link);
    } catch {
      // Windows sem o modo de desenvolvedor não cria link de arquivo; a junção cobre o mesmo `lstat`.
      const junction = path.join(c.files, 'juncao');
      await fsp.symlink(c.files, junction, 'junction');
      const r = await box.add([junction], A);
      assert.equal(r.added.length, 0);
      assert.match(r.rejected[0].reason, /Links simbólicos/);
      t.diagnostic('sem permissão para link de arquivo: testado com junção');
      return;
    }
    const r = await box.add([link], A);
    assert.equal(r.added.length, 0);
    assert.match(r.rejected[0].reason, /Links simbólicos/);
  });

  it('uma pasta do caminho que vira link depois da escolha não entrega o arquivo de outro lugar', async () => {
    const box = c.make();
    const file = await c.write('sub/a.txt', 'original');
    // Segundos inteiros: o outro arquivo fica com a mesma data, para só o caminho denunciar a troca.
    const when = new Date('2026-01-02T03:04:05Z');
    await fsp.utimes(file, when, when);
    const [added] = (await box.add([file], A)).added;
    const moved = path.join(c.files, 'guardado');
    await fsp.rename(path.join(c.files, 'sub'), moved);
    const outra = path.join(c.files, 'outra');
    await fsp.mkdir(outra);
    await fsp.writeFile(path.join(outra, 'a.txt'), 'original');
    await fsp.utimes(path.join(outra, 'a.txt'), when, when);
    await fsp.symlink(outra, path.join(c.files, 'sub'), 'junction');
    await assert.rejects(box.beginDelivery(A.id, added.id, 'lan'), codeOf('NOT_FOUND'));
    assert.equal(box.views()[0].state, 'failed');
  });

  it('arquivo que mudou (tamanho ou data) vira `changed` e não é entregue', async () => {
    const box = c.make();
    const f1 = await c.write('tamanho.txt', 'abc');
    const f2 = await c.write('data.txt', 'abc');
    const [a, b] = (await box.add([f1, f2], A)).added;
    await fsp.writeFile(f1, 'abcdef');
    await assert.rejects(box.beginDelivery(A.id, a.id, 'lan'), codeOf('CHANGED'));
    assert.equal(box.views().find((v) => v.id === a.id)?.state, 'changed');

    await fsp.utimes(f2, new Date(), new Date(Date.now() + 60_000));
    const list = await box.listFor(A.id);
    assert.equal(list.find((i) => i.id === b.id)?.state, 'changed', 'a lista já mostra');
    await assert.rejects(box.beginDelivery(A.id, b.id, 'remote'), codeOf('CHANGED'));
  });

  it('arquivo apagado vira `failed` com o motivo; unidade desconectada só espera', async () => {
    const box = c.make();
    const f1 = await c.write('sumiu.txt');
    const f2 = await c.write('hd/externo.txt');
    const [a, b] = (await box.add([f1, f2], A)).added;
    await fsp.rm(f1);
    await assert.rejects(box.beginDelivery(A.id, a.id, 'lan'), codeOf('NOT_FOUND'));
    const failed = box.views().find((v) => v.id === a.id);
    assert.equal(failed?.state, 'failed');
    assert.match(failed?.reason ?? '', /não está mais no PC/);

    const hd = path.join(c.files, 'hd');
    const fora = path.join(c.dir, 'hd-fora');
    await fsp.rename(hd, fora);
    await assert.rejects(box.beginDelivery(A.id, b.id, 'lan'), codeOf('ROOT_UNAVAILABLE'));
    await box.tick();
    assert.equal(box.views().find((v) => v.id === b.id)?.state, 'waiting', 'o HD pode voltar');
    await fsp.rename(fora, hd);
    assert.equal((await box.beginDelivery(A.id, b.id, 'lan')).name, 'externo.txt');
  });

  it('celular errado não vê, não baixa, não confirma e não recusa o item de outro', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    const [added] = (await box.add([file], A)).added;
    assert.deepEqual(await box.listFor(B.id), []);
    for (const fn of [
      () => box.beginDelivery(B.id, added.id, 'lan'),
      () => box.inspect(B.id, added.id),
      () => box.done(B.id, added.id),
      () => box.decline(B.id, added.id),
    ]) {
      await assert.rejects(fn(), codeOf('NOT_FOUND'));
    }
    assert.equal((await box.listFor(A.id))[0].state, 'waiting', 'nada mudou para o dono');
    await assert.rejects(box.done(A.id, randomFsId()), codeOf('NOT_FOUND'), 'o erro é igual ao de um id que não existe');
  });

  it('`done` e `decline` são idempotentes e o estado final não muda', async () => {
    const box = c.make();
    const [f1, f2] = await Promise.all([c.write('a.txt'), c.write('b.txt')]);
    const [a, b] = (await box.add([f1, f2], A)).added;

    assert.equal((await box.done(A.id, a.id)).transitioned, true);
    const repeat = await box.done(A.id, a.id);
    assert.equal(repeat.transitioned, false);
    assert.equal(repeat.item.state, 'delivered');
    assert.equal((await box.decline(A.id, a.id)).item.state, 'delivered', 'recusar depois de entregue não muda nada');

    assert.equal((await box.decline(A.id, b.id)).transitioned, true);
    assert.equal((await box.decline(A.id, b.id)).item.state, 'declined');
    assert.equal((await box.done(A.id, b.id)).item.state, 'declined');

    assert.deepEqual(await box.listFor(A.id), [], 'entregue e recusado saem da lista do celular');
    await assert.rejects(box.beginDelivery(A.id, a.id, 'lan'), codeOf('NOT_FOUND'));
    assert.ok(existsSync(f1) && existsSync(f2), 'entregar ou recusar não apaga o original');
  });

  it('o celular dispensa o aviso de `changed` e o item segue na tela do PC', async () => {
    const box = c.make();
    const file = await c.write('a.txt', 'abc');
    const [added] = (await box.add([file], A)).added;
    await fsp.writeFile(file, 'abcdef');
    assert.equal((await box.listFor(A.id))[0].state, 'changed');
    assert.equal((await box.decline(A.id, added.id)).item.state, 'changed');
    assert.deepEqual(await box.listFor(A.id), []);
    assert.equal(box.views()[0].state, 'changed');
  });

  it('cancelar tira o item, o celular passa a receber NOT_FOUND e o original fica', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    const [added] = (await box.add([file], A)).added;
    const notified: string[] = [];
    box.on('notify', (p: string) => notified.push(p));
    assert.equal(await box.cancel(added.id), true);
    assert.equal(await box.cancel(added.id), false, 'repetir não faz nada');
    assert.deepEqual(notified, [A.id]);
    assert.deepEqual(box.views(), []);
    await assert.rejects(box.beginDelivery(A.id, added.id, 'lan'), codeOf('NOT_FOUND'));
    assert.ok(existsSync(file));
  });

  it('avisa o celular certo quando entra arquivo; ações do próprio celular não geram aviso', async () => {
    const box = c.make();
    const notified: string[] = [];
    box.on('notify', (p: string) => notified.push(p));
    const [f1, f2] = await Promise.all([c.write('a.txt'), c.write('b.txt')]);
    const { added } = await box.add([f1, f2], B);
    assert.deepEqual(notified, [B.id], 'um aviso por lote');
    await box.done(B.id, added[0].id);
    await box.decline(B.id, added[1].id);
    assert.deepEqual(notified, [B.id]);
  });

  it('limpar ao sair da conta apaga só a lista, também em disco', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    await box.add([file], A);
    await box.clear();
    assert.deepEqual(box.views(), []);
    const again = c.make();
    await again.load();
    assert.deepEqual(again.views(), []);
    assert.ok(existsSync(file), 'o arquivo do usuário não é tocado');
  });

  it('celular que saiu da conta perde os itens dele; os dos outros ficam', async () => {
    const box = c.make();
    const [f1, f2] = await Promise.all([c.write('a.txt'), c.write('b.txt')]);
    await box.add([f1], A);
    await box.add([f2], B);
    await box.retainPhones([B.id]);
    assert.deepEqual(
      box.views().map((v) => v.phoneId),
      [B.id],
    );
  });

  it('progresso: mostra a fração, avisa a tela só a cada 1% e solta quem parou de baixar', async () => {
    const box = c.make();
    const file = await c.write('a.bin', Buffer.alloc(1000));
    const [added] = (await box.add([file], A)).added;
    await box.beginDelivery(A.id, added.id, 'lan');
    let changes = 0;
    box.on('changed', () => changes++);
    for (let n = 1; n <= 500; n++) box.progress(added.id, n);
    assert.equal(box.views()[0].progress, 0.5);
    assert.ok(changes <= 51, `avisos demais: ${changes}`);
    assert.equal(box.views()[0].via, 'lan');

    c.now.t += FS_OUTBOX_IDLE_MS;
    await box.tick();
    assert.equal(box.views()[0].state, 'waiting');
    assert.equal(box.views()[0].progress, null);
  });

  it('`done` depois de o item voltar a esperar ainda conta: o celular terminou de baixar', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    const [added] = (await box.add([file], A)).added;
    await box.beginDelivery(A.id, added.id, 'remote');
    c.now.t += FS_OUTBOX_IDLE_MS;
    await box.tick();
    assert.equal((await box.done(A.id, added.id)).item.state, 'delivered');
  });

  it('limpa da tela o que terminou há mais de 7 dias', async () => {
    const box = c.make();
    const file = await c.write('a.txt');
    const [added] = (await box.add([file], A)).added;
    await box.done(A.id, added.id);
    c.now.t += FS_PUSH_TTL_MS + 1000;
    await box.tick();
    assert.deepEqual(box.views(), []);
  });
});

describe('caixa de saída no despachante (§11)', () => {
  let k: FsKit;
  let box: FsOutbox;
  let file: string;
  let sent: string[];

  beforeEach(async () => {
    sent = [];
    // `outbox` entra por uma segunda instância do serviço, com as mesmas peças.
    k = await fsKit({ writePerSecond: 5 });
    box = new FsOutbox({ dataDir: k.dataDir, ctx: k.roots.ctx });
    file = path.join(k.base, 'relatorio.pdf');
    await fsp.writeFile(file, 'conteudo do relatorio');
    (k.service as unknown as { o: { outbox?: FsOutbox } }).o.outbox = box;
    k.service.remote = {
      download: () => Promise.reject(new Error('não usado')),
      upload: () => Promise.reject(new Error('não usado')),
      uploadStatus: () => Promise.reject(new Error('não usado')),
      outboxDownload: async (ctx, req) => {
        sent.push(req.id);
        await box.beginDelivery(ctx.phoneId, req.id, 'remote');
        return { blobId: 'blob' } as FsDownloadPrepared;
      },
    };
  });
  afterEach(async () => {
    await k.cleanup();
  });

  const run = (phoneId: string, req: FsRequest, via: 'lan' | 'remote' = 'remote') => k.service.execute({ phoneId, via }, req);

  it('funciona com o interruptor desligado e sem nenhuma pasta liberada, mas as pastas continuam fechadas', async () => {
    assert.equal(k.roots.enabled, false);
    assert.equal(k.roots.roots.length, 0);
    const [added] = (await box.add([file], A)).added;
    const list = await run(A.id, { op: 'outboxList' });
    assert.ok(list.ok);
    assert.deepEqual(
      (list.data as FsOutboxListResponse).items.map((i) => i.id),
      [added.id],
    );
    assert.equal((list.data as FsOutboxListResponse).pcName, 'PC-TESTE');
    assert.equal((await run(A.id, { op: 'outboxDownload', id: added.id })).ok, true);
    assert.deepEqual(sent, [added.id]);
    const done = await run(A.id, { op: 'outboxDone', id: added.id });
    assert.ok(done.ok);
    assert.equal((done.data as FsOutboxItemResponse).item.state, 'delivered');

    for (const req of [{ op: 'roots' }, { op: 'list', rootId: 'aaaaaaaaaaaaaaaa', path: '' }] as FsRequest[]) {
      const r = await run(A.id, req);
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'FS_DISABLED');
    }
  });

  it('a operação só aceita `id`: não existe forma de pedir um caminho', () => {
    const parsed = parseFsRequest({ op: 'outboxDownload', id: 'x', path: file });
    assert.ok(!parsed.ok, 'id curto demais é recusado');
    const withPath = parseFsRequest({ op: 'outboxDownload', id: randomFsId(), rootId: 'a', path: file });
    assert.ok(withPath.ok);
    assert.deepEqual(Object.keys(withPath.request).sort(), ['id', 'op'], 'o resto é descartado');
  });

  it('na LAN, `outboxDownload` pelo despachante é recusado: lá existe a rota de conteúdo', async () => {
    const [added] = (await box.add([file], A)).added;
    const r = await run(A.id, { op: 'outboxDownload', id: added.id }, 'lan');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'UNSUPPORTED_OP');
  });

  it('confirmar e recusar respeitam o limite de 5 alterações por segundo; listar não', async () => {
    const paths = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (n) => {
        const p = path.join(k.base, `${n}.txt`);
        await fsp.writeFile(p, 'x');
        return p;
      }),
    );
    const { added } = await box.add(paths, A);
    const codes: string[] = [];
    for (const a of added) {
      const r = await run(A.id, { op: 'outboxDecline', id: a.id });
      codes.push(r.ok ? 'ok' : r.error.code);
    }
    assert.deepEqual(codes, ['ok', 'ok', 'ok', 'ok', 'ok', 'RATE_LIMITED']);
    for (let i = 0; i < 10; i++) assert.equal((await run(A.id, { op: 'outboxList' })).ok, true);
  });

  it('registra no histórico só o que mudou, com o nome e sem caminho', async () => {
    const [a] = (await box.add([file], A)).added;
    await run(A.id, { op: 'outboxDecline', id: a.id });
    await run(A.id, { op: 'outboxDecline', id: a.id });
    await run(A.id, { op: 'outboxList' });
    const entries = k.audit.entries().filter((e) => e.op !== 'browse');
    assert.equal(entries.length, 1, 'repetir e listar não entram');
    assert.equal(entries[0].op, 'outboxDecline');
    assert.equal(entries[0].path, 'relatorio.pdf');
    assert.equal(entries[0].rootId, null);
  });

  it('celular errado recebe o mesmo NOT_FOUND nas três operações', async () => {
    const [a] = (await box.add([file], A)).added;
    for (const op of ['outboxDownload', 'outboxDone', 'outboxDecline'] as const) {
      const r = await k.service.execute({ phoneId: B.id, via: 'remote' }, { op, id: a.id });
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'NOT_FOUND');
    }
  });

  it('sem caixa de saída na build: UNSUPPORTED_OP', async () => {
    (k.service as unknown as { o: { outbox?: FsOutbox } }).o.outbox = undefined;
    const r = await run(A.id, { op: 'outboxList' });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'UNSUPPORTED_OP');
  });
});

describe('caixa de saída nas rotas da LAN (§11)', () => {
  const pairKey = newPairKey();
  let k: FsKit;
  let box: FsOutbox;
  let server: LanServer;
  let base: string;
  let file: string;
  const content = Buffer.from('conteudo do arquivo enviado pelo PC');

  beforeEach(async () => {
    k = await fsKit();
    box = new FsOutbox({ dataDir: k.dataDir, ctx: k.roots.ctx });
    (k.service as unknown as { o: { outbox?: FsOutbox } }).o.outbox = box;
    file = path.join(k.base, 'nota.txt');
    await fsp.writeFile(file, content);
    server = new LanServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.1.0',
      storage: new Storage(() => null),
      getContext: () => ({ deviceId: 'pc-1', pairKey, allowedPhones: new Set([A.id, B.id]) }),
      reportLocation: () => Promise.resolve(),
      fs: new FsLanRoutes({ service: k.service, minFreeMarginBytes: 0 }),
    });
    base = `http://127.0.0.1:${await server.start()}`;
  });
  afterEach(async () => {
    await server.stop();
    await k.cleanup();
  });

  const get = async (
    phone: string,
    route: string,
    params: Record<string, string> = {},
    headers: Record<string, string> = {},
    method = 'GET',
  ) => {
    const query = canonicalFsQuery(params);
    const sig = await signLanFsRequest({ pairKey, phoneDeviceId: phone, method, path: route, query });
    return fetch(`${base}${route}${query ? `?${query}` : ''}`, { method, headers: { ...sig, ...headers } });
  };
  const post = async (phone: string, route: string, body: unknown) => {
    const bytes = utf8Encode(JSON.stringify(body));
    const sig = await signLanFsRequest({
      pairKey,
      phoneDeviceId: phone,
      method: 'POST',
      path: route,
      query: '',
      bodySha256: await sha256Hex(bytes),
    });
    return fetch(`${base}${route}`, {
      method: 'POST',
      headers: { ...sig, 'content-type': 'application/json' },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  };

  it('ping anuncia `fs-push`', async () => {
    const r = (await (await fetch(`${base}/v1/ping`)).json()) as { capabilities?: string[] };
    assert.ok(r.capabilities?.includes(CAPABILITIES.fsPush));
  });

  it('lista, baixa com Range e confirma, com o interruptor desligado', async () => {
    assert.equal(k.roots.enabled, false);
    const [added] = (await box.add([file], A)).added;
    const list = (await (await get(A.id, FS_LAN_ROUTES.outbox)).json()) as FsOutboxListResponse;
    assert.equal(list.items[0].name, 'nota.txt');

    const head = await get(A.id, FS_LAN_ROUTES.outboxDownload, { id: added.id }, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(box.views()[0].state, 'waiting', 'HEAD não conta como começar a baixar');

    const part = await get(A.id, FS_LAN_ROUTES.outboxDownload, { id: added.id }, { range: 'bytes=0-9' });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), content.subarray(0, 10).toString());
    assert.equal(box.views()[0].state, 'downloading');
    const rest = await get(
      A.id,
      FS_LAN_ROUTES.outboxDownload,
      { id: added.id },
      { range: `bytes=10-`, 'if-range': part.headers.get('etag')! },
    );
    assert.equal(rest.status, 206);
    assert.equal(Buffer.from(await rest.arrayBuffer()).toString(), content.subarray(10).toString());
    assert.equal(box.views()[0].progress, 1);

    const done = await post(A.id, FS_LAN_ROUTES.outboxDone, { op: 'outboxDone', id: added.id });
    assert.equal(done.status, 200);
    assert.equal(((await done.json()) as FsOutboxItemResponse).item.state, 'delivered');
    const after = await get(A.id, FS_LAN_ROUTES.outboxDownload, { id: added.id });
    assert.equal(after.status, 404);
  });

  it('celular errado: lista vazia e 404 no conteúdo e nas ações', async () => {
    const [added] = (await box.add([file], A)).added;
    assert.deepEqual(((await (await get(B.id, FS_LAN_ROUTES.outbox)).json()) as FsOutboxListResponse).items, []);
    assert.equal((await get(B.id, FS_LAN_ROUTES.outboxDownload, { id: added.id })).status, 404);
    assert.equal((await post(B.id, FS_LAN_ROUTES.outboxDone, { op: 'outboxDone', id: added.id })).status, 404);
    assert.equal((await post(B.id, FS_LAN_ROUTES.outboxDecline, { op: 'outboxDecline', id: added.id })).status, 404);
    assert.equal(box.views()[0].state, 'waiting');
  });

  it('arquivo que mudou responde 409 CHANGED', async () => {
    const [added] = (await box.add([file], A)).added;
    await fsp.writeFile(file, 'outra coisa, com outro tamanho');
    const r = await get(A.id, FS_LAN_ROUTES.outboxDownload, { id: added.id });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'CHANGED');
  });

  it('celular fora da lista de pares não entra (a assinatura vale, o celular não)', async () => {
    const r = await get('phone-estranho', FS_LAN_ROUTES.outbox);
    assert.equal(r.status, 403);
  });

  it('recusar pela rota responde o estado e não apaga o original', async () => {
    const [added] = (await box.add([file], A)).added;
    const r = await post(A.id, FS_LAN_ROUTES.outboxDecline, { op: 'outboxDecline', id: added.id });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as FsOutboxItemResponse).item.state, 'declined');
    assert.ok(existsSync(file));
  });

  it('`op` diferente da rota é recusado', async () => {
    const [added] = (await box.add([file], A)).added;
    const r = await post(A.id, FS_LAN_ROUTES.outboxDone, { op: 'outboxDecline', id: added.id });
    assert.equal(r.status, 400);
    assert.equal(box.views()[0].state, 'waiting');
  });
});
