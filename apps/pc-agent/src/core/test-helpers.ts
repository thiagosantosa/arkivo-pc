// Utilitários só para testes (não é carregado pelo app).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import type { FileRecord, FsPlatform, Transfer } from '@arkivo/shared';
import type { DirAttributeProbe } from './fs-attrs';
import { FsAuditLog } from './fs-audit';
import type { FsPlatformAdapter } from './fs-platform';
import { buildFsSystemContext, RootRegistry, type SharedRoot } from './fs-roots';
import { FsService } from './fs-service';
import { signLanRequest } from './lan-auth';
import type { WsConnection } from './types';

export async function tempDir(prefix = 'arkivo-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Pasta temporária fora das pastas bloqueadas pelas pastas liberadas (§10.2): o `os.tmpdir()` fica em
 * `Users\<x>\AppData` no Windows e em `/tmp` (ou `/var`) no Linux/macOS, que o PC nunca libera.
 * Fica em `apps/pc-agent/.fs-test-tmp/` (ignorada pelo git).
 */
export async function fsTempDir(prefix = 'fs-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = path.resolve(__dirname, '..', '..', '.fs-test-tmp');
  await fsp.mkdir(base, { recursive: true });
  const dir = await fsp.realpath(await mkdtemp(path.join(base, prefix)));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const newPairKey = () => randomBytes(32).toString('base64');

/** Cabeçalhos assinados como o celular faria. */
export function signedHeaders(opts: {
  pairKey: string;
  phoneId: string;
  method: string;
  path: string;
  hash?: string;
  ts?: number;
}): Record<string, string> {
  const ts = String(opts.ts ?? Date.now());
  const h: Record<string, string> = {
    'X-Arkivo-Device': opts.phoneId,
    'X-Arkivo-Ts': ts,
    'X-Arkivo-Sig': signLanRequest(opts.pairKey, opts.method, opts.path, ts, opts.hash ?? ''),
  };
  if (opts.hash) h['X-Arkivo-Hash'] = opts.hash;
  return h;
}

// =================================================================== pastas liberadas (§10)

export const hostFsPlatform: FsPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

export interface FsKit {
  tmp: string;
  dataDir: string;
  /** Onde os testes criam as pastas que viram raízes. */
  base: string;
  trashDir: string;
  roots: RootRegistry;
  service: FsService;
  audit: FsAuditLog;
  /** Liga/desliga a Lixeira do volume falso. */
  volume: { trash: boolean };
  trashCalls: string[];
  thumbCalls: { n: number };
  /** Cria `base/<nome>` e libera como raiz. */
  addRoot(name: string): Promise<{ id: string; abs: string }>;
  cleanup(): Promise<void>;
}

export interface FsKitOptions {
  normalizationFallback?: boolean;
  thumbDelayMs?: number;
  now?: () => number;
  readPerSecond?: number;
  writePerSecond?: number;
  dirAttributes?: DirAttributeProbe;
  /** Pastas protegidas além do perfil e dos dados (ex.: a pasta do backup). */
  protectedDirs?: () => readonly (string | null | undefined)[];
}

/** `FsService` completo contra uma pasta temporária real, com Lixeira, miniaturas e volume falsos. */
export async function fsKit(o: FsKitOptions = {}): Promise<FsKit> {
  const { dir: tmp, cleanup } = await fsTempDir();
  const dataDir = path.join(tmp, 'data');
  const base = path.join(tmp, 'pastas');
  const trashDir = path.join(tmp, 'lixeira');
  await Promise.all([dataDir, base, trashDir].map((d) => fsp.mkdir(d, { recursive: true })));
  let saved: { roots: SharedRoot[]; enabled: boolean } = { roots: [], enabled: false };
  const volume = { trash: true };
  const roots = new RootRegistry({
    store: { load: () => saved, save: async (p) => void (saved = p) },
    ctx: buildFsSystemContext({ platform: hostFsPlatform, home: path.join(tmp, 'home'), env: {}, extraBlocked: [dataDir] }),
    volumes: { info: async () => ({ drive: 'X:', trashAvailable: volume.trash }) },
    protectedDirs: o.protectedDirs,
  });
  const trashCalls: string[] = [];
  const thumbCalls = { n: 0 };
  const platform: FsPlatformAdapter = {
    trashItem: async (abs) => {
      trashCalls.push(abs);
      await fsp.rename(abs, path.join(trashDir, `${trashCalls.length}-${path.basename(abs)}`));
    },
    canThumbnail: (mime) => !!mime && mime.startsWith('image/'),
    thumbnail: async (abs, size) => {
      thumbCalls.n++;
      if (o.thumbDelayMs) await sleep(o.thumbDelayMs);
      const data = await fsp.readFile(abs);
      if (!data.length) return null;
      return { jpeg: Buffer.from(`JPEG${size}:${sha256(data)}`), width: size, height: size };
    },
  };
  const audit = new FsAuditLog(dataDir, { now: o.now, flushDelayMs: 10 });
  const service = new FsService({
    roots,
    platform,
    volumes: { info: async () => ({ drive: 'X:', trashAvailable: volume.trash }) },
    audit,
    pcName: () => 'PC-TESTE',
    phoneName: (id) => (id === 'phone-1' ? 'Galaxy' : null),
    normalizationFallback: o.normalizationFallback,
    dirAttributes: o.dirAttributes,
    readPerSecond: o.readPerSecond ?? 10_000,
    writePerSecond: o.writePerSecond ?? 10_000,
    now: o.now,
  });
  return {
    tmp,
    dataDir,
    base,
    trashDir,
    roots,
    service,
    audit,
    volume,
    trashCalls,
    thumbCalls,
    async addRoot(name) {
      const abs = path.join(base, name);
      await fsp.mkdir(abs, { recursive: true });
      const r = await roots.add(abs);
      return { id: r.id, abs: r.absPath };
    },
    async cleanup() {
      await audit.flush().catch(() => undefined);
      await cleanup();
    },
  };
}

/** Escreve arquivos (`{ 'a/b.txt': 'conteúdo' }`); termina em `/` = pasta. */
export async function writeTree(root: string, tree: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, ...rel.split('/').filter(Boolean));
    if (rel.endsWith('/')) {
      await fsp.mkdir(abs, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void>;

/** Servidor HTTP local que faz o papel da API. */
export async function startFakeApi(handler: Handler): Promise<{ url: string; close: () => Promise<void>; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(data);
}

export function fileRecord(p: Partial<FileRecord> & { hash: string; size: number }): FileRecord {
  const now = new Date().toISOString();
  return {
    id: 'f1',
    name: 'IMG_0001.jpg',
    kind: 'photo',
    mimeType: 'image/jpeg',
    takenAt: '2026-11-03T12:00:00.000Z',
    createdAt: now,
    updatedAt: now,
    locations: [],
    onPhone: true,
    status: 'pending',
    ...p,
  };
}

export function transfer(id: string, file: FileRecord): Transfer {
  const now = new Date().toISOString();
  return { id, fileId: file.id, file, targetDeviceId: 'pc1', mode: 'relay', status: 'ready', bytesReceived: file.size, size: file.size, createdAt: now, updatedAt: now };
}

/** WebSocket falso controlado pelo teste. */
export class FakeWs implements WsConnection {
  sent: string[] = [];
  closed = false;
  private openCb: () => void = () => {};
  private msgCb: (t: string) => void = () => {};
  private closeCb: (c: number, r: string) => void = () => {};
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeCb(1000, '');
  }
  onOpen(cb: () => void) {
    this.openCb = cb;
  }
  onMessage(cb: (t: string) => void) {
    this.msgCb = cb;
  }
  onClose(cb: (c: number, r: string) => void) {
    this.closeCb = cb;
  }
  onError() {}
  // controles do teste
  simulateOpen() {
    this.openCb();
  }
  simulateMessage(obj: unknown) {
    this.msgCb(JSON.stringify(obj));
  }
  simulateDrop(code = 1006, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.closeCb(code, reason);
  }
}

export function fakeWsFactory() {
  const sockets: FakeWs[] = [];
  const factory = (url: string) => {
    const ws = new FakeWs(url);
    sockets.push(ws);
    return ws;
  };
  return { sockets, factory };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000, label = 'condição'): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Tempo esgotado esperando ${label}`);
    await sleep(10);
  }
}

// =================================================================== espião do sistema de arquivos

export type FsOp = 'open' | 'write' | 'sync' | 'datasync' | 'close' | 'rename' | 'mark';

export interface FsEvent {
  op: FsOp;
  /** Caminho absoluto (para `mark`, o rótulo). */
  path: string;
  /** `rename`: destino. `open`: flags. `mark`: detalhe opcional. */
  extra?: string;
}

/** Devolve um erro para simular falha naquela operação (ou `undefined` para seguir normalmente). */
export type FsFault = (op: FsOp, file: string) => NodeJS.ErrnoException | undefined;

export function errno(code: string, syscall = 'write'): NodeJS.ErrnoException {
  const e = new Error(`${code}: falha simulada (${syscall})`) as NodeJS.ErrnoException;
  e.code = code;
  e.syscall = syscall;
  return e;
}

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

/**
 * Espiona `fs.promises.open`/`rename` e `FileHandle#write/sync/datasync/close` (o código do app usa
 * esses caminhos), registrando a ordem com o caminho de cada handle. `fault` injeta erros.
 * `mark` acrescenta eventos do teste (hash, report, ack) na mesma linha do tempo.
 */
export async function spyFs(fault?: FsFault) {
  const events: FsEvent[] = [];
  const fdPath = new Map<number, string>();
  const probe = await fsp.open(process.execPath, 'r');
  const proto = Object.getPrototypeOf(probe) as Record<string, AnyAsync>;
  await probe.close();

  const mocks: { mock: { restore(): void } }[] = [];
  const realOpen = fsp.open.bind(fsp) as unknown as AnyAsync;
  const realRename = fsp.rename.bind(fsp) as unknown as AnyAsync;
  const fsObj = fsp as unknown as Record<string, AnyAsync>;

  mocks.push(
    mock.method(fsObj, 'open', async (...args: unknown[]) => {
      const p = path.resolve(String(args[0]));
      const err = fault?.('open', p);
      if (err) throw err;
      const fh = (await realOpen(...args)) as FileHandle;
      fdPath.set(fh.fd, p);
      events.push({ op: 'open', path: p, extra: typeof args[1] === 'string' || typeof args[1] === 'number' ? String(args[1]) : 'r' });
      // `close` é campo da instância (não está no protótipo do FileHandle).
      const realClose = fh.close.bind(fh);
      fh.close = () => {
        events.push({ op: 'close', path: p });
        return realClose();
      };
      return fh;
    }),
  );
  mocks.push(
    mock.method(fsObj, 'rename', async (...args: unknown[]) => {
      const from = path.resolve(String(args[0]));
      const to = path.resolve(String(args[1]));
      events.push({ op: 'rename', path: from, extra: to });
      const err = fault?.('rename', from);
      if (err) throw err;
      return realRename(...args);
    }),
  );
  for (const op of ['write', 'sync', 'datasync'] as const) {
    const real = proto[op];
    mocks.push(
      mock.method(proto, op, function (this: FileHandle, ...args: unknown[]) {
        const p = fdPath.get(this.fd) ?? `fd:${this.fd}`;
        events.push({ op, path: p });
        const err = fault?.(op, p);
        if (err) return Promise.reject(err);
        return real.apply(this, args);
      }),
    );
  }

  return {
    events,
    mark(label: string, extra?: string) {
      events.push({ op: 'mark', path: label, extra });
    },
    restore() {
      for (const m of mocks.reverse()) m.mock.restore();
    },
  };
}

export type FsStep = [label: string, match: (e: FsEvent) => boolean];

/** Confere que cada passo aparece depois do anterior na linha do tempo. Devolve os índices. */
export function assertOrder(events: FsEvent[], steps: FsStep[]): number[] {
  const found: number[] = [];
  let i = -1;
  for (const [label, match] of steps) {
    const j = events.findIndex((e, k) => k > i && match(e));
    if (j < 0) {
      const dump = events.map((e) => `${e.op} ${e.path}${e.extra ? ` → ${e.extra}` : ''}`).join('\n  ');
      assert.fail(`passo "${label}" não aconteceu depois de "${found.length ? steps[found.length - 1][0] : 'início'}".\nEventos:\n  ${dump}`);
    }
    found.push(j);
    i = j;
  }
  return found;
}

export const isOp = (op: FsOp, file?: string) => (e: FsEvent) => e.op === op && (file === undefined || e.path === path.resolve(file));
export const isMark = (label: string) => (e: FsEvent) => e.op === 'mark' && e.path === label;
