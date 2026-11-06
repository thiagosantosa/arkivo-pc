import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITIES, hasCapability, type LocationReport, type PcPlatform, type UpgradeRequiredInfo, type WsMessage } from '@arkivo/shared';
import { ActivityLog } from './activity-log';
import type { ActiveTransferView, AgentState, TransferRoute } from './agent-state';
import { ApiClient, ApiError, FetchLike } from './api-client';
import { ConfigStore, Credentials } from './config-store';
import { noDirAttributes, windowsDirAttributes, type DirAttributeProbe } from './fs-attrs';
import { FsAuditLog } from './fs-audit';
import { FsLanRoutes } from './fs-lan';
import { FsOutbox, type OutboxAddResult } from './fs-outbox';
import { headlessFsPlatform, type FsPlatformAdapter } from './fs-platform';
import { FsRemote } from './fs-remote';
import { buildDriveViews, findDrive } from './fs-drives';
import { buildFsSystemContext, RootRegistry, type RootAddOptions, type RootAddPlan, type SharedRoot } from './fs-roots';
import { FsService } from './fs-service';
import { SystemVolumeProbe, type DriveEntry, type DriveLister, type VolumeProbe } from './fs-volume';
import { readJson, SerialQueue, writeFileAtomic } from './fs-utils';
import { LanCompletedEvent, LanServer, LanUploadEvent } from './lan-server';
import { freeBytes as freeBytesOf, lanIPv4Addresses } from './net-info';
import { PairingFlow, PairingResult } from './pairing';
import { RealtimeClient } from './realtime';
import { RelayCompletedEvent, RelayProgressEvent, RelayWorker } from './relay-worker';
import { monthFolder, PARTS_DIR_NAME, Storage } from './storage';
import { consoleLogger, Logger, QrEncoder, SecretCipher, WsFactory } from './types';

export const NOTES = {
  unpaired: 'Celular desconectado deste PC. Escaneie de novo para voltar a receber backups.',
  loggedOut: 'Você saiu da conta neste PC. Para entrar de novo, escaneie este código com o app.',
  revoked: 'Este PC foi desconectado da sua conta pelo celular. Escaneie de novo para voltar a receber backups.',
} as const;

export interface AgentOptions {
  dataDir: string;
  cipher: SecretCipher;
  wsFactory: WsFactory;
  qr: QrEncoder;
  appVersion: string;
  platform: PcPlatform;
  pcName: string;
  apiBaseUrl: string;
  /** Pasta sugerida no passo 1 (ex.: Imagens/Arkivo). */
  suggestedStorageDir: string;
  lanHost?: string;
  /** Força a porta LAN (testes usam 0). */
  lanPort?: number;
  minFreeMarginBytes?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
  /** Pastas liberadas (§10): Lixeira e miniaturas do Electron (padrão: sem Electron, sem Lixeira nem prévias). */
  fsPlatform?: FsPlatformAdapter;
  /** Tipo do volume de cada pasta (padrão: consulta o sistema). */
  volumeProbe?: VolumeProbe;
  /** Atributos oculto/offline do Windows (padrão: `cmd /u dir` no Windows). */
  dirAttributes?: DirAttributeProbe;
  /** `os.homedir()` (testes trocam). */
  homeDir?: string;
  /** "Unidades deste PC" (padrão: consulta o sistema, como `volumeProbe`). */
  driveLister?: DriveLister;
  /** Variáveis do Windows para o bloqueio do sistema (`%SystemDrive%` etc., §10.2; padrão: `process.env`; testes trocam). */
  fsEnv?: NodeJS.ProcessEnv;
  /** `realpath` das pastas liberadas (padrão: o nativo; testes trocam para simular uma unidade com `subst`). */
  fsRealpath?: (p: string) => Promise<string>;
  /** Espera do `upload` remoto antes de responder `pending` (testes encurtam). */
  fsCommitWaitMs?: number;
}

/**
 * O que o Arkivo anuncia: `fs` e `fs-push` sempre que a build tem os recursos, mesmo com o interruptor "Acesso pelo
 * celular" desligado (§10.5, §10.9, §11).
 */
export const PC_CAPABILITIES = [CAPABILITIES.fs, CAPABILITIES.fsPush];

/** Peças das pastas liberadas e da caixa de saída (montadas no `init`, depois de ler o `config.json`). */
export interface FsStack {
  roots: RootRegistry;
  drives: DriveLister;
  audit: FsAuditLog;
  outbox: FsOutbox;
  service: FsService;
  lan: FsLanRoutes;
  remote: FsRemote;
}

interface PendingReport extends LocationReport {
  fileId: string;
}

interface ActiveTransfer extends ActiveTransferView {
  startedAt: number;
  startOffset: number;
}

const RECEIVING_SPEED_WINDOW_MS = 3_000;

/**
 * Orquestrador: liga configuração, pareamento, WebSocket, servidor LAN, relay e log de atividade.
 * Expõe `state` (AgentState) e emite `state` sempre que algo muda (no máx. ~8x/s).
 */
export class Agent extends EventEmitter {
  readonly config: ConfigStore;
  readonly api: ApiClient;
  readonly activity: ActivityLog;
  readonly storage: Storage;
  private readonly log: Logger;
  private pairing: PairingFlow | null = null;
  private realtime: RealtimeClient | null = null;
  private lanServer: LanServer | null = null;
  private relay: RelayWorker | null = null;
  private creds: Credentials | null = null;
  private readonly active = new Map<string, ActiveTransfer>();
  private speedSamples: { t: number; bytes: number }[] = [];
  private pendingReports: PendingReport[] = [];
  private readonly reportsFile: string;
  private readonly reportsWrites = new SerialQueue();
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;
  private wasReceiving = false;
  private s: AgentState;
  private fsStack: FsStack | null = null;
  private fsViewTimer: NodeJS.Timeout | null = null;
  /** Última lista de "Unidades deste PC" e o `realpath` da raiz de cada uma (para marcar as já liberadas). */
  private driveEntries: DriveEntry[] = [];
  private driveReals = new Map<string, string>();
  private drivesPending: Promise<void> | null = null;

  constructor(private readonly opts: AgentOptions) {
    super();
    this.log = opts.logger ?? consoleLogger;
    this.config = new ConfigStore({
      dir: opts.dataDir,
      cipher: opts.cipher,
      defaults: { apiBaseUrl: opts.apiBaseUrl, pcName: opts.pcName },
      logger: this.log,
    });
    this.api = new ApiClient({
      baseUrl: opts.apiBaseUrl,
      getDeviceToken: () => this.creds?.deviceToken ?? null,
      fetchImpl: opts.fetchImpl,
      userAgent: `ArkivoPC/${opts.appVersion}`,
      clientVersion: opts.appVersion,
      onUpgradeRequired: (info) => void this.enterUpdateRequired(info),
    });
    this.activity = new ActivityLog(opts.dataDir);
    this.storage = new Storage(() => this.config.settings.storageDir, { logger: this.log });
    this.reportsFile = path.join(opts.dataDir, 'pending-reports.json');
    this.s = {
      phase: 'loading',
      updateRequired: null,
      appVersion: opts.appVersion,
      platform: opts.platform,
      pcName: opts.pcName,
      storageDir: null,
      freeBytes: null,
      autostart: true,
      secretsProtected: false,
      pairing: null,
      note: null,
      account: null,
      serverConnected: false,
      lan: { listening: false, port: opts.lanPort ?? 0, addresses: [], error: null },
      phones: [],
      lastRoute: null,
      lastActivityAt: null,
      active: [],
      queued: 0,
      speedBps: null,
      log: [],
      months: [],
      totalSaved: 0,
      totalBytes: 0,
      error: null,
      fs: { enabled: false, roots: [], drives: [], audit: [] },
      outbox: [],
    };
  }

  /** Pastas liberadas (depois do `init`). */
  get fs(): FsStack {
    if (!this.fsStack) throw new Error('Agente não iniciado');
    return this.fsStack;
  }

  get state(): AgentState {
    return this.s;
  }

  // =================================================================== ciclo de vida

  async init(): Promise<void> {
    await fsp.mkdir(this.opts.dataDir, { recursive: true });
    await this.config.load();
    await this.activity.load();
    this.pendingReports = (await readJson<PendingReport[]>(this.reportsFile)) ?? [];
    this.creds = this.config.getCredentials();
    await this.initFs();
    const st = this.config.settings;
    this.patch({
      autostart: st.autostart,
      storageDir: st.storageDir ?? this.opts.suggestedStorageDir,
      secretsProtected: this.config.secretsProtected,
      account: st.account,
      phones: st.phones,
      lan: { ...this.s.lan, port: this.lanPort() },
    });
    this.refreshActivity();
    await this.refreshFreeBytes();

    if (this.creds && st.storageDir) {
      this.patch({ phase: 'active' });
      await this.startServices();
    } else if (st.storageDir) {
      this.goPairing(null);
    } else {
      this.patch({ phase: 'folder' });
    }
    this.timers.push(setInterval(() => void this.refreshFreeBytes(), 30_000));
    this.timers.push(setInterval(() => void this.refreshFsView(), 30_000));
    this.timers.push(setInterval(() => void this.fsStack?.outbox.tick().catch(() => undefined), 30_000));
    this.timers.push(setInterval(() => void this.flushReports(), 60_000));
  }

  async shutdown(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.pairing?.stop();
    await this.stopServices();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.fsViewTimer) clearTimeout(this.fsViewTimer);
    await this.fsStack?.audit.flush().catch(() => undefined);
    await this.fsStack?.outbox.flush().catch(() => undefined);
  }

  // =================================================================== pastas liberadas (§10)

  private async initFs(): Promise<void> {
    const o = this.opts;
    const ctx = buildFsSystemContext({ platform: o.platform, home: o.homeDir ?? os.homedir(), env: o.fsEnv ?? process.env, extraBlocked: [path.resolve(o.dataDir)] });
    const system = new SystemVolumeProbe({ platform: o.platform, systemDrive: ctx.systemDrive });
    const volumes = o.volumeProbe ?? system;
    const roots = new RootRegistry({
      store: {
        load: () => ({ roots: [...this.config.settings.fsRoots], enabled: this.config.settings.fsEnabled }),
        save: (p) => this.config.update({ fsRoots: p.roots, fsEnabled: p.enabled }),
      },
      ctx,
      volumes,
      // A pasta do backup não pode ser movida, renomeada nem apagada pelo celular (nem levada junto com a de cima).
      protectedDirs: () => [this.config.settings.storageDir],
      realpath: o.fsRealpath,
      logger: this.log,
    });
    const audit = new FsAuditLog(o.dataDir, { logger: this.log });
    await audit.load();
    const outbox = new FsOutbox({ dataDir: o.dataDir, ctx: roots.ctx, logger: this.log });
    await outbox.load();
    const service = new FsService({
      roots,
      outbox,
      platform: o.fsPlatform ?? headlessFsPlatform,
      volumes,
      audit,
      pcName: () => this.config.settings.pcName,
      phoneName: (id) => this.s.phones.find((p) => p.id === id)?.name ?? null,
      dirAttributes: o.dirAttributes ?? (process.platform === 'win32' ? windowsDirAttributes : noDirAttributes),
      logger: this.log,
    });
    const lan = new FsLanRoutes({ service, minFreeMarginBytes: o.minFreeMarginBytes, logger: this.log });
    const remote = new FsRemote({
      service,
      api: this.api,
      send: (m) => this.realtime?.send(m) ?? false,
      getCreds: () => (this.creds ? { deviceId: this.creds.deviceId, pairKey: this.creds.pairKey, allowedPhones: new Set(this.s.phones.map((p) => p.id)) } : null),
      dataDir: o.dataDir,
      minFreeMarginBytes: o.minFreeMarginBytes,
      commitWaitMs: o.fsCommitWaitMs,
      logger: this.log,
    });
    await remote.load();
    this.fsStack = { roots, drives: o.driveLister ?? system, audit, outbox, service, lan, remote };
    roots.on('changed', () => {
      this.scheduleFsView();
      // §10.11: o celular recarrega `roots` (na LAN ele só consulta de novo).
      void remote.emitEvent({ kind: 'rootsChanged' });
    });
    audit.on('changed', () => this.scheduleFsView());
    outbox.on('changed', () => this.publishOutbox());
    // §11: o evento só acelera; o celular também consulta a lista (ao abrir, ao voltar, ao reconectar e a cada 30 s).
    outbox.on('notify', (phoneId: string) => void remote.emitEvent({ kind: 'outboxChanged', phoneId }));
    this.publishOutbox();
    await this.refreshFsView();
  }

  private publishOutbox(): void {
    const outbox = this.fsStack?.outbox;
    if (outbox) this.patch({ outbox: outbox.views() });
  }

  /**
   * "Enviar para o celular" (§11): confere cada arquivo e põe na fila de um celular. Recusa o celular que não sabe
   * receber, para o arquivo não ficar esperando à toa; o que não passa na conferência volta em `rejected`, por arquivo.
   */
  async outboxAdd(paths: readonly unknown[], phoneId: string): Promise<OutboxAddResult> {
    const phone = this.s.phones.find((p) => p.id === phoneId);
    if (!phone) throw new Error('Este celular não está mais pareado com o PC.');
    if (!hasCapability(phone.capabilities, CAPABILITIES.fsPush)) throw new Error('Atualize o Arkivo no celular para ele poder receber arquivos do PC.');
    return this.fs.outbox.add(paths, { id: phone.id, name: phone.name });
  }

  /** "Cancelar" (ativo) ou "Remover da lista" (encerrado). O arquivo original nunca é tocado. */
  async outboxCancel(id: string): Promise<void> {
    await this.fs.outbox.cancel(id);
  }

  /**
   * "Adicionar pasta" / "Liberar inteira": recusa com a mensagem pronta (`RootRejectError`). Unidade inteira que
   * contém pastas liberadas só entra com `replace` (as pastas que o usuário confirmou trocar, §10.2).
   */
  async fsAddRoot(dir: string, o: RootAddOptions = {}): Promise<SharedRoot> {
    return this.fs.roots.add(dir, o);
  }

  /** O que liberar `dir` faria (unidade inteira? troca quais pastas?), sem liberar: a tela confirma antes. */
  fsPlanRoot(dir: string, o: { label?: string } = {}): Promise<RootAddPlan> {
    return this.fs.roots.plan(dir, o);
  }

  /** Unidade da lista atual pelo `id` que o renderer mandou (enumera de novo: o pen drive pode ter saído). */
  async fsDrive(id: unknown): Promise<DriveEntry | null> {
    await this.refreshDrives();
    return findDrive(this.driveEntries, id);
  }

  /**
   * "Unidades deste PC" (§10.13 [2026-11-06]): enumera de novo e atualiza `state.fs.drives`. A tela chama ao abrir,
   * ao ganhar foco e a cada ~10 s; chamadas ao mesmo tempo esperam a mesma enumeração.
   */
  refreshDrives(): Promise<void> {
    if (!this.drivesPending) {
      this.drivesPending = (async () => {
        const st = this.fsStack;
        if (!st) return;
        const entries = await st.drives.listDrives().catch(() => [] as DriveEntry[]);
        const reals = new Map<string, string>();
        await Promise.all(entries.map(async (d) => reals.set(d.id, await realpathWithin(st.roots, d.root, 2_000))));
        this.driveEntries = entries;
        this.driveReals = reals;
        await this.refreshFsView();
      })().finally(() => {
        this.drivesPending = null;
      });
    }
    return this.drivesPending;
  }

  async fsRemoveRoot(id: string): Promise<void> {
    await this.fs.roots.remove(id);
  }

  async fsRenameRoot(id: string, label: string): Promise<void> {
    await this.fs.roots.rename(id, label);
  }

  async fsSetEnabled(on: boolean): Promise<void> {
    await this.fs.roots.setEnabled(on);
  }

  async fsClearAudit(): Promise<void> {
    await this.fs.audit.clear();
  }

  private scheduleFsView(): void {
    if (this.fsViewTimer) return;
    this.fsViewTimer = setTimeout(() => {
      this.fsViewTimer = null;
      void this.refreshFsView();
    }, 150);
  }

  private async refreshFsView(): Promise<void> {
    const st = this.fsStack;
    if (!st) return;
    const roots = await st.roots.infos().catch(() => []);
    this.patch({
      fs: {
        enabled: st.roots.enabled,
        roots: roots.map((r) => ({ id: r.id, label: r.label, absPath: r.absPath, drive: r.drive, available: r.available, trashAvailable: r.trashAvailable, freeBytes: r.freeBytes, addedAt: r.addedAt })),
        drives: buildDriveViews(this.driveEntries, st.roots.roots, { platform: st.roots.platform, systemDrive: st.roots.ctx.systemDrive, reals: this.driveReals }),
        audit: st.audit.entries(200).map((e) => ({ ...e })),
      },
    });
  }

  // =================================================================== ações da UI

  /** Passo 1 → valida e grava a pasta (cria se preciso, testa escrita). */
  async setStorageDir(dir: string): Promise<void> {
    const abs = path.resolve(dir);
    await fsp.mkdir(abs, { recursive: true });
    const probe = path.join(abs, `.arkivo-teste-${process.pid}`);
    try {
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
    } catch (err) {
      const msg = 'Não dá para gravar nesta pasta. Escolha outra.';
      this.patch({ error: msg });
      throw new Error(msg, { cause: err });
    }
    await this.config.update({ storageDir: abs });
    this.patch({ storageDir: abs, error: null });
    await this.refreshFreeBytes();
    if (this.s.phase === 'active') {
      await this.pushSelf();
      void this.realtime?.sendStatus();
    }
  }

  async setAutostart(on: boolean): Promise<void> {
    await this.config.update({ autostart: on });
    this.patch({ autostart: on });
  }

  /** "Continuar" do passo 1. */
  async continueToPairing(): Promise<void> {
    if (this.blockedForUpdate) return;
    if (!this.config.settings.storageDir) await this.setStorageDir(this.s.storageDir ?? this.opts.suggestedStorageDir);
    if (this.creds) {
      this.patch({ phase: 'active' });
      await this.startServices();
      return;
    }
    this.goPairing(null);
  }

  /** "Desconectar" o celular na tela de Configurações. */
  unpairPhone(): Promise<void> {
    return this.leaveAccount(NOTES.unpaired);
  }

  /** "Sair da conta neste PC". */
  logout(): Promise<void> {
    return this.leaveAccount(NOTES.loggedOut);
  }

  clearError(): void {
    this.patch({ error: null });
  }

  // =================================================================== versão recusada (contrato §9)

  private get blockedForUpdate(): boolean {
    return this.s.phase === 'updateRequired';
  }

  /**
   * A API respondeu `426 UPGRADE_REQUIRED` (ou fechou o WS com `4426`): para de tentar — WebSocket,
   * relay, pareamento e servidor LAN — e mostra a tela de atualização. Credenciais, pasta e histórico ficam
   * intactos; a versão nova retoma de onde parou ao abrir.
   */
  private async enterUpdateRequired(info: UpgradeRequiredInfo): Promise<void> {
    const view = { minVersion: info.minVersion ?? this.s.updateRequired?.minVersion ?? null, protocol: info.protocol };
    if (this.blockedForUpdate) {
      if (view.minVersion !== this.s.updateRequired?.minVersion) this.patch({ updateRequired: view });
      return;
    }
    this.log.warn(`A API recusou o Arkivo para PC ${this.opts.appVersion}; mínimo ${view.minVersion ?? 'não informado'}`);
    // Tira os ouvintes antes de parar: o `stop()` emite um último `state` que sobrescreveria `pairing: null`.
    this.pairing?.removeAllListeners();
    this.pairing?.stop();
    this.pairing = null;
    this.patch({ phase: 'updateRequired', updateRequired: view, pairing: null, active: [], queued: 0 });
    this.active.clear();
    await this.stopServices();
  }

  // =================================================================== pareamento

  private goPairing(note: string | null): void {
    if (this.blockedForUpdate) return;
    this.pairing?.stop();
    this.pairing?.removeAllListeners();
    const flow = new PairingFlow({
      api: this.api,
      qr: this.opts.qr,
      wsFactory: this.opts.wsFactory,
      pcName: this.config.settings.pcName,
      platform: this.opts.platform,
      logger: this.log,
    });
    this.pairing = flow;
    flow.on('state', (p) => {
      if (this.pairing !== flow) return;
      this.patch({ pairing: { status: p.status, qrDataUrl: p.qrDataUrl, link: p.qrPayload, expiresAt: p.expiresAt, error: p.error } });
    });
    flow.on('claimed', (r: PairingResult) => {
      if (this.pairing !== flow) return;
      void this.onPaired(r).catch((err) => this.log.error('Falha ao concluir pareamento', err));
    });
    this.patch({ phase: 'pairing', note, pairing: { status: 'creating', qrDataUrl: null, link: null, expiresAt: null, error: null } });
    flow.start();
  }

  private async onPaired(r: PairingResult): Promise<void> {
    this.pairing?.removeAllListeners();
    this.pairing = null;
    const creds: Credentials = { deviceId: r.deviceId, deviceToken: r.deviceToken, pairKey: r.pairKey, account: r.user };
    await this.config.setCredentials(creds);
    this.creds = creds;
    if (this.blockedForUpdate) return;
    this.patch({ phase: 'active', note: null, pairing: null, account: r.user });
    await this.startServices();
  }

  private async leaveAccount(note: string): Promise<void> {
    if (this.creds) {
      try {
        await this.api.logout();
      } catch (err) {
        // Sem internet: sai localmente mesmo assim. O PC continua listado na conta até ser removido pelo celular.
        this.log.warn('Logout na API falhou; saindo localmente', err instanceof Error ? err.message : err);
      }
    }
    await this.resetToPairing(note);
  }

  private async resetToPairing(note: string): Promise<void> {
    await this.stopServices();
    this.creds = null;
    await this.config.clearCredentials();
    // Saiu da conta: o próximo pareamento pode ser de outra pessoa. As pastas continuam na lista, mas o acesso
    // só volta quando o usuário ligar o interruptor de novo.
    await this.fsStack?.roots.setEnabled(false);
    // §11: a caixa de saída era desta conta. Só a lista some; os arquivos do usuário ficam onde estão.
    await this.fsStack?.outbox.clear();
    this.pendingReports = [];
    await this.saveReports();
    this.active.clear();
    this.patch({ account: null, phones: [], serverConnected: false, active: [], queued: 0, lastRoute: null });
    this.goPairing(note);
  }

  // =================================================================== serviços

  private lanPort(): number {
    return this.opts.lanPort ?? this.config.settings.lanPort;
  }

  private async startServices(): Promise<void> {
    if (!this.creds || this.blockedForUpdate) return;
    await this.stopServices();
    const creds = this.creds;

    // --- servidor LAN
    const lan = new LanServer({
      port: this.lanPort(),
      host: this.opts.lanHost,
      version: this.opts.appVersion,
      storage: this.storage,
      minFreeMarginBytes: this.opts.minFreeMarginBytes,
      getContext: () =>
        this.creds
          ? {
              deviceId: this.creds.deviceId,
              pairKey: this.creds.pairKey,
              allowedPhones: new Set(this.s.phones.map((p) => p.id)),
            }
          : null,
      reportLocation: (fileId, report) => this.reportLocation(fileId, report),
      fs: this.fsStack?.lan ?? null,
      logger: this.log,
    });
    this.lanServer = lan;
    lan.on('progress', (e: LanUploadEvent) => this.onProgress(`lan:${e.fileId}`, 'lan', e.name, e.takenAt, e.received, e.total, 'receiving'));
    lan.on('verifying', (e: LanUploadEvent) => this.onProgress(`lan:${e.fileId}`, 'lan', e.name, e.takenAt, e.received, e.total, 'verifying'));
    lan.on('completed', (e: LanCompletedEvent) => void this.onCompleted(`lan:${e.fileId}`, 'lan', e));
    lan.on('failed', (e: { fileId: string; name: string; reason: string }) => void this.onFailed(`lan:${e.fileId}`, 'lan', e.fileId, e.name, e.reason, false));
    try {
      const port = await lan.start();
      this.patch({ lan: { listening: true, port, addresses: lanIPv4Addresses(), error: null } });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'EADDRINUSE' ? `A porta ${this.lanPort()} já está em uso; envio direto desativado (o relay continua funcionando).` : 'Envio direto indisponível neste PC.';
      this.log.error('Servidor LAN não iniciou', err);
      this.lanServer = null;
      this.patch({ lan: { listening: false, port: this.lanPort(), addresses: [], error: msg } });
    }

    if (this.blockedForUpdate) {
      // A API recusou a versão enquanto o servidor LAN abria.
      await this.stopServices();
      return;
    }

    // --- relay
    const relay = new RelayWorker({ api: this.api, storage: this.storage, minFreeMarginBytes: this.opts.minFreeMarginBytes, logger: this.log });
    this.relay = relay;
    relay.on('progress', (e: RelayProgressEvent) => this.onProgress(`relay:${e.transferId}`, 'relay', e.name, e.takenAt, e.received, e.total, 'receiving'));
    relay.on('verifying', (e: RelayProgressEvent) => this.onProgress(`relay:${e.transferId}`, 'relay', e.name, e.takenAt, e.received, e.total, 'verifying'));
    relay.on('completed', (e: RelayCompletedEvent) => void this.onCompleted(`relay:${e.transferId}`, 'relay', e));
    relay.on('failed', (e: { transferId: string; fileId: string; name: string; reason: string; willRetry: boolean }) =>
      void this.onFailed(`relay:${e.transferId}`, 'relay', e.fileId, e.name, e.reason, e.willRetry),
    );
    relay.on('queue', (n: number) => this.patch({ queued: n }));
    relay.start();

    // --- WebSocket
    const rt = new RealtimeClient({
      api: this.api,
      getDeviceToken: () => this.creds?.deviceToken ?? null,
      wsFactory: this.opts.wsFactory,
      getStatus: async () => ({
        lanAddresses: this.lanServer?.listening ? lanIPv4Addresses() : [],
        lanPort: this.lanServer?.port ?? this.lanPort(),
        freeBytes: (await this.refreshFreeBytes()) ?? 0,
        receiving: this.isReceiving(),
        capabilities: PC_CAPABILITIES,
      }),
      beforeReconnect: async () => {
        try {
          await this.api.getSelf();
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            void this.handleRevoked();
            return false;
          }
        }
        return true;
      },
      logger: this.log,
    });
    this.realtime = rt;
    rt.on('connected', () => {
      this.patch({ serverConnected: true });
      void this.onServerConnected(creds);
    });
    rt.on('disconnected', () => this.patch({ serverConnected: false }));
    rt.on('message', (m: WsMessage) => this.onWsMessage(m));
    rt.on('upgradeRequired', (info: UpgradeRequiredInfo) => void this.enterUpdateRequired(info));
    rt.start();
    void this.cleanStaleParts();
    void this.fsStack?.lan.cleanup().catch((err: unknown) => this.log.warn('Limpeza dos envios parciais (pastas liberadas)', err instanceof Error ? err.message : err));
  }

  private async stopServices(): Promise<void> {
    this.realtime?.stop();
    this.realtime?.removeAllListeners();
    this.realtime = null;
    this.relay?.stop();
    this.relay?.removeAllListeners();
    this.relay = null;
    const lan = this.lanServer;
    this.lanServer = null;
    if (lan) {
      lan.removeAllListeners();
      await lan.stop();
    }
    this.patch({ lan: { ...this.s.lan, listening: false }, serverConnected: false });
  }

  private async onServerConnected(creds: Credentials): Promise<void> {
    if (this.creds !== creds) return;
    await Promise.allSettled([this.refreshPeers(), this.pushSelf(), this.flushReports()]);
    try {
      await this.relay?.syncPending();
    } catch (err) {
      this.log.warn('Falha ao buscar pendências do relay', err instanceof Error ? err.message : err);
    }
  }

  private onWsMessage(m: WsMessage): void {
    switch (m.type) {
      case 'transfer.ready':
        if (m.data?.transfer) this.relay?.enqueue(m.data.transfer);
        break;
      case 'device.revoked':
        void this.handleRevoked();
        break;
      case 'peers.changed':
        if (Array.isArray(m.data?.phones)) void this.setPhones(m.data.phones);
        break;
      case 'fs.request':
        void this.fsStack?.remote.handleRequest(m.data);
        break;
      default:
        break;
    }
  }

  private async handleRevoked(): Promise<void> {
    if (!this.creds || this.blockedForUpdate) return;
    this.log.warn('Este PC foi removido da conta');
    await this.resetToPairing(NOTES.revoked);
  }

  private async refreshPeers(): Promise<void> {
    try {
      const r = await this.api.getPeers();
      await this.setPhones(r.phones ?? []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void this.handleRevoked();
      else this.log.warn('Falha ao atualizar celulares pareados', err instanceof Error ? err.message : err);
    }
  }

  private async setPhones(phones: { id: string; name: string; capabilities?: string[] }[]): Promise<void> {
    const clean = phones
      .filter((p) => p && typeof p.id === 'string')
      .map((p) => ({
        id: p.id,
        name: String(p.name ?? ''),
        ...(Array.isArray(p.capabilities) ? { capabilities: p.capabilities.filter((c) => typeof c === 'string') } : {}),
      }));
    await this.config.update({ phones: clean });
    this.patch({ phones: clean });
    // §11: celular que saiu da conta não recebe mais nada; os itens dele saem da caixa de saída.
    await this.fsStack?.outbox.retainPhones(clean.map((p) => p.id));
  }

  private async pushSelf(): Promise<void> {
    if (!this.creds) return;
    try {
      await this.api.patchSelf({
        lanAddresses: this.lanServer?.listening ? lanIPv4Addresses() : [],
        lanPort: this.lanServer?.port ?? this.lanPort(),
        freeBytes: this.s.freeBytes ?? undefined,
        folderLabel: this.config.settings.storageDir ?? undefined,
        appVersion: this.opts.appVersion,
        capabilities: PC_CAPABILITIES,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void this.handleRevoked();
      else this.log.warn('Falha no PATCH /devices/pc/self', err instanceof Error ? err.message : err);
    }
  }

  // =================================================================== relatórios de local (modo LAN)

  /** Reporta à API; se falhar por rede, guarda para reenviar (o arquivo já está salvo e conferido no disco). */
  private async reportLocation(fileId: string, report: LocationReport): Promise<void> {
    try {
      await this.api.reportLocation(fileId, report);
    } catch (err) {
      if (err instanceof ApiError && !err.retryable) {
        this.log.error(`API recusou o local de ${fileId}: ${err.code} ${err.message}`);
        return;
      }
      this.log.warn(`Sem servidor; local de ${fileId} fica para reenviar`);
      this.pendingReports = this.pendingReports.filter((r) => r.fileId !== fileId);
      this.pendingReports.push({ fileId, ...report });
      await this.saveReports();
    }
  }

  private async flushReports(): Promise<void> {
    if (!this.creds || !this.pendingReports.length) return;
    const list = [...this.pendingReports];
    for (const r of list) {
      try {
        await this.api.reportLocation(r.fileId, { relativePath: r.relativePath, verifiedHash: r.verifiedHash });
      } catch (err) {
        if (err instanceof ApiError && err.retryable) break; // servidor fora: tenta depois
        this.log.error(`Relatório de local descartado (${r.fileId})`, err instanceof Error ? err.message : err);
      }
      this.pendingReports = this.pendingReports.filter((p) => p !== r);
    }
    await this.saveReports();
  }

  private saveReports(): Promise<void> {
    const snap = JSON.stringify(this.pendingReports);
    // tmp → fsync → rename → fsync do diretório: um corte de energia não deixa o arquivo truncado.
    return this.reportsWrites.run(() => writeFileAtomic(this.reportsFile, snap, 0o600, { logger: this.log }));
  }

  // =================================================================== progresso

  private onProgress(key: string, route: TransferRoute, name: string, takenAt: string | null, received: number, total: number, phase: 'receiving' | 'verifying'): void {
    const now = Date.now();
    let a = this.active.get(key);
    if (!a) {
      a = { key, name, route, received, total, phase, startedAt: now, startOffset: received, folder: monthFolder(takenAt) };
      this.active.set(key, a);
    }
    const delta = received - a.received;
    if (delta > 0) this.speedSamples.push({ t: now, bytes: delta });
    a.received = received;
    a.total = total;
    a.phase = phase;
    this.patch({ lastRoute: route, lastActivityAt: new Date(now).toISOString() });
    this.publishActive();
  }

  private async onCompleted(key: string, route: TransferRoute, e: LanCompletedEvent | RelayCompletedEvent): Promise<void> {
    const a = this.active.get(key);
    this.active.delete(key);
    const now = Date.now();
    await this.activity.add({
      fileId: e.fileId,
      name: e.relativePath.split('/').pop() ?? e.name,
      relativePath: e.relativePath,
      size: e.size,
      hash: e.hash,
      route,
      status: 'saved',
      duplicate: e.alreadyExisted,
      durationMs: a ? Math.max(1, now - a.startedAt) : undefined,
      bytesTransferred: a ? Math.max(0, e.size - a.startOffset) : undefined,
    });
    this.patch({ lastRoute: route, lastActivityAt: new Date(now).toISOString() });
    this.refreshActivity();
    this.publishActive();
    void this.refreshFreeBytes();
  }

  private async onFailed(key: string, route: TransferRoute, fileId: string, name: string, reason: string, willRetry: boolean): Promise<void> {
    this.active.delete(key);
    this.publishActive();
    if (willRetry) return;
    await this.activity.add({ fileId, name, relativePath: null, size: 0, hash: null, route, status: 'failed', error: reason });
    this.refreshActivity();
  }

  private isReceiving(): boolean {
    return this.active.size > 0 || !!this.relay?.isBusy;
  }

  private publishActive(): void {
    const now = Date.now();
    this.speedSamples = this.speedSamples.filter((s) => now - s.t <= RECEIVING_SPEED_WINDOW_MS);
    const receiving = this.isReceiving();
    let speed: number | null;
    if (this.active.size) {
      const bytes = this.speedSamples.reduce((acc, s) => acc + s.bytes, 0);
      speed = bytes / (RECEIVING_SPEED_WINDOW_MS / 1000);
    } else {
      speed = this.activity.averageSpeed(this.s.lastRoute ?? undefined);
    }
    this.patch({
      active: [...this.active.values()].map(({ startedAt: _a, startOffset: _b, ...v }) => v),
      speedBps: speed,
    });
    if (receiving !== this.wasReceiving) {
      this.wasReceiving = receiving;
      void this.realtime?.sendStatus();
    }
  }

  private refreshActivity(): void {
    this.patch({
      log: this.activity.entries(60),
      months: this.activity.monthCounts(),
      totalSaved: this.activity.totalSaved,
      totalBytes: this.activity.totalBytes,
    });
  }

  private async refreshFreeBytes(): Promise<number | null> {
    const dir = this.config.settings.storageDir ?? this.s.storageDir;
    if (!dir) return null;
    try {
      const free = await freeBytesOf(dir);
      if (free !== this.s.freeBytes) this.patch({ freeBytes: free });
      return free;
    } catch {
      return null;
    }
  }

  /** Apaga `.part` com mais de 14 dias (retomadas abandonadas). */
  private async cleanStaleParts(): Promise<void> {
    const root = this.config.settings.storageDir;
    if (!root) return;
    const dir = path.join(root, PARTS_DIR_NAME);
    try {
      const names = await fsp.readdir(dir);
      const limit = Date.now() - 14 * 24 * 3600_000;
      for (const n of names) {
        const p = path.join(dir, n);
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.isFile() && st.mtimeMs < limit) await fsp.rm(p, { force: true });
      }
    } catch {
      /* pasta ainda não existe */
    }
  }

  // =================================================================== estado observável

  private patch(p: Partial<AgentState>): void {
    this.s = { ...this.s, ...p };
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('state', this.s);
    }, 120);
  }
}

/** `realpath` da raiz de uma unidade com teto (unidade de rede caída pode demorar); falhou → a própria raiz. */
async function realpathWithin(roots: RootRegistry, p: string, ms: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      roots.realpath(p).catch(() => p),
      new Promise<string>((r) => {
        timer = setTimeout(() => r(p), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
