import { EventEmitter } from 'node:events';
import { PAIRING_TTL_SECONDS, PairingUser, PcPlatform, WsMessage } from '@arkivo/shared';
import { ApiClient } from './api-client';
import { Clock, Logger, QrEncoder, silentLogger, WsConnection, WsFactory } from './types';

export interface PairingResult {
  deviceId: string;
  deviceToken: string;
  pairKey: string;
  user: PairingUser;
}

export interface PairingState {
  status: 'idle' | 'creating' | 'waiting' | 'error' | 'claimed';
  pairingId: string | null;
  qrDataUrl: string | null;
  /** Mesmo conteúdo do QR (`arkivo://pair?...`), para copiar e colar no celular sem câmera. */
  qrPayload: string | null;
  /** Epoch ms (relógio do PC) em que o código expira. */
  expiresAt: number | null;
  error: string | null;
}

export interface PairingFlowOptions {
  api: ApiClient;
  qr: QrEncoder;
  wsFactory?: WsFactory;
  pcName: string;
  platform: PcPlatform;
  ttlSeconds?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  now?: Clock;
  logger?: Logger;
}

/**
 * Pareamento por QR (§4): cria o pareamento, mostra o QR, conta 300 s e renova ao expirar.
 * Espera `pairing.claimed` pelo WebSocket anônimo; se o WS não estiver aberto, faz polling a cada 2 s.
 *
 * Eventos: `state` (PairingState), `claimed` (PairingResult).
 */
export class PairingFlow extends EventEmitter {
  private gen = 0;
  private st: PairingState = { status: 'idle', pairingId: null, qrDataUrl: null, qrPayload: null, expiresAt: null, error: null };
  private timers: NodeJS.Timeout[] = [];
  private ws: WsConnection | null = null;
  private wsOpen = false;
  private polling = false;
  private done = false;
  private readonly log: Logger;
  private readonly now: Clock;

  constructor(private readonly opts: PairingFlowOptions) {
    super();
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  get state(): PairingState {
    return this.st;
  }

  start(): void {
    this.done = false;
    void this.cycle();
  }

  stop(): void {
    this.gen++;
    this.teardown();
    if (this.st.status !== 'claimed') this.setState({ status: 'idle', pairingId: null, qrDataUrl: null, qrPayload: null, expiresAt: null, error: null });
  }

  private teardown(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.polling = false;
    this.wsOpen = false;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* já fechado */
    }
  }

  private setState(patch: Partial<PairingState>): void {
    this.st = { ...this.st, ...patch };
    this.emit('state', this.st);
  }

  private later(gen: number, ms: number, fn: () => void): void {
    this.timers.push(
      setTimeout(() => {
        if (gen === this.gen && !this.done) fn();
      }, ms),
    );
  }

  private async cycle(): Promise<void> {
    const gen = ++this.gen;
    this.teardown();
    this.setState({ status: 'creating', error: null });
    const ttl = (this.opts.ttlSeconds ?? PAIRING_TTL_SECONDS) * 1000;
    try {
      const created = await this.opts.api.createPairing({ pcName: this.opts.pcName, platform: this.opts.platform });
      const qrDataUrl = await this.opts.qr(created.qrPayload);
      if (gen !== this.gen) return;
      // Conta pelo relógio local (evita diferenças de relógio com o servidor), sem passar do `expiresAt` declarado.
      const serverLeft = Date.parse(created.expiresAt) - Date.now();
      const left = Number.isFinite(serverLeft) && serverLeft > 0 ? Math.min(ttl, serverLeft) : ttl;
      this.setState({
        status: 'waiting',
        pairingId: created.pairingId,
        qrDataUrl,
        qrPayload: created.qrPayload,
        expiresAt: this.now() + left,
        error: null,
      });
      this.later(gen, left, () => void this.cycle());
      this.openWs(gen, created.pairingId, created.pollToken);
      if (!this.opts.wsFactory) this.startPolling(gen, created.pairingId, created.pollToken);
    } catch (err) {
      if (gen !== this.gen) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('Falha ao criar pareamento', msg);
      this.setState({ status: 'error', qrDataUrl: null, qrPayload: null, expiresAt: null, error: 'Sem conexão com o servidor. Tentando de novo…' });
      this.later(gen, this.opts.retryDelayMs ?? 5_000, () => void this.cycle());
    }
  }

  private openWs(gen: number, pairingId: string, pollToken: string): void {
    if (!this.opts.wsFactory) return;
    let ws: WsConnection;
    try {
      ws = this.opts.wsFactory(this.opts.api.wsUrl({ pairing: pairingId, pollToken }));
    } catch (err) {
      this.log.warn('WS de pareamento indisponível', err);
      this.startPolling(gen, pairingId, pollToken);
      return;
    }
    this.ws = ws;
    ws.onOpen(() => {
      if (gen === this.gen) this.wsOpen = true;
    });
    ws.onMessage((text) => {
      if (gen !== this.gen) return;
      let msg: WsMessage;
      try {
        msg = JSON.parse(text) as WsMessage;
      } catch {
        return;
      }
      if (msg.type === 'pairing.claimed') this.complete(gen, msg.data);
      else if (msg.type === 'pairing.expired') void this.cycle();
    });
    ws.onError(() => undefined);
    ws.onClose(() => {
      if (gen !== this.gen || this.done) return;
      this.wsOpen = false;
      // Sem WS: polling a cada 2 s até expirar.
      this.startPolling(gen, pairingId, pollToken);
    });
    // Se o WS não abrir logo, começa o polling mesmo assim.
    this.later(gen, 3_000, () => {
      if (!this.wsOpen) this.startPolling(gen, pairingId, pollToken);
    });
  }

  private startPolling(gen: number, pairingId: string, pollToken: string): void {
    if (this.polling || gen !== this.gen) return;
    this.polling = true;
    const interval = this.opts.pollIntervalMs ?? 2_000;
    const tick = async () => {
      if (gen !== this.gen || this.done) return;
      if (this.wsOpen) {
        // WS voltou: deixa o WS entregar o segredo (o deviceToken sai uma vez só).
        this.polling = false;
        return;
      }
      try {
        const r = await this.opts.api.pollPairing(pairingId, pollToken);
        if (gen !== this.gen || this.done) return;
        if (r.status === 'claimed') {
          if (r.deviceId && r.deviceToken && r.pairKey && r.user) {
            this.complete(gen, { deviceId: r.deviceId, deviceToken: r.deviceToken, pairKey: r.pairKey, user: r.user });
            return;
          }
          // Reclamado mas sem segredo (já entregue a outra conexão): recomeça.
          this.log.warn('Pareamento reclamado sem segredo; gerando novo código');
          void this.cycle();
          return;
        }
        if (r.status === 'expired') {
          void this.cycle();
          return;
        }
      } catch (err) {
        this.log.warn('Polling do pareamento falhou', err instanceof Error ? err.message : err);
      }
      this.later(gen, interval, () => void tick());
    };
    this.later(gen, interval, () => void tick());
  }

  private complete(gen: number, data: PairingResult): void {
    if (this.done || gen !== this.gen) return;
    if (!data?.deviceId || !data.deviceToken || !data.pairKey) return;
    this.done = true;
    this.teardown();
    this.setState({ status: 'claimed', error: null });
    const user: PairingUser = { name: data.user?.name ?? '', handle: data.user?.handle ?? '', email: data.user?.email ?? '' };
    this.emit('claimed', { deviceId: data.deviceId, deviceToken: data.deviceToken, pairKey: data.pairKey, user });
  }
}
