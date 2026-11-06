import { EventEmitter } from 'node:events';
import { WS_CLOSE, parseUpgradeCloseReason, type WsMessage } from '@arkivo/shared';
import { ApiClient } from './api-client';
import { Logger, silentLogger, WsConnection, WsFactory } from './types';

export interface PcStatus {
  lanAddresses: string[];
  lanPort: number;
  freeBytes: number;
  receiving: boolean;
  /** [2026-11-04] Recursos do PC (`['fs']`, §10.9). */
  capabilities?: string[];
}

export interface RealtimeOptions {
  api: ApiClient;
  getDeviceToken: () => string | null;
  wsFactory: WsFactory;
  getStatus: () => Promise<PcStatus>;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reenvia `pc.status` periodicamente (IP pode mudar, espaço livre muda). */
  statusIntervalMs?: number;
  /**
   * Chamado antes de cada reconexão após uma falha. Retornar `false` interrompe
   * (ex.: a API respondeu 401 porque o PC foi removido enquanto estava offline).
   */
  beforeReconnect?: () => Promise<boolean>;
  random?: () => number;
  logger?: Logger;
}

/**
 * WebSocket autenticado do PC (§5) com reconexão exponencial.
 * Eventos: `connected`, `disconnected`, `message` (WsMessage), `stopped`,
 * `upgradeRequired` (UpgradeRequiredInfo) — a API fechou com `4426` (§9); não reconecta mais.
 */
export class RealtimeClient extends EventEmitter {
  private ws: WsConnection | null = null;
  private running = false;
  private open = false;
  private failures = 0;
  /** A API fechou com 4401/4001: confere as credenciais antes da próxima tentativa. */
  private authClosed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(private readonly opts: RealtimeOptions) {
    super();
    this.log = opts.logger ?? silentLogger;
  }

  get connected(): boolean {
    return this.open;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.reconnectTimer = this.statusTimer = null;
    const ws = this.ws;
    this.ws = null;
    const wasOpen = this.open;
    this.open = false;
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
    if (wasOpen) this.emit('disconnected');
  }

  /** Envia uma mensagem agora; `false` se o WebSocket não está aberto. */
  send(msg: WsMessage): boolean {
    if (!this.open || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.log.warn('Falha ao enviar pelo WebSocket', err);
      return false;
    }
  }

  /** Envia `pc.status` agora (se conectado). */
  async sendStatus(): Promise<void> {
    if (!this.open || !this.ws) return;
    const ws = this.ws;
    try {
      const data = await this.opts.getStatus();
      if (ws !== this.ws || !this.open) return;
      const msg: WsMessage = { type: 'pc.status', data };
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn('Falha ao enviar pc.status', err);
    }
  }

  /** Atraso da próxima reconexão: exponencial com jitter (50–100%). */
  backoffDelay(failures: number): number {
    const min = this.opts.minBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    const base = Math.min(max, min * 2 ** Math.max(0, failures - 1));
    return Math.round(base * (0.5 + (this.opts.random ?? Math.random)() * 0.5));
  }

  private connect(): void {
    if (!this.running) return;
    const token = this.opts.getDeviceToken();
    if (!token) {
      this.log.warn('Sem deviceToken; WebSocket não conecta');
      return;
    }
    let ws: WsConnection;
    try {
      ws = this.opts.wsFactory(this.opts.api.wsUrl({ device: token }));
    } catch (err) {
      this.log.warn('Falha ao abrir WebSocket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onOpen(() => {
      if (ws !== this.ws) return;
      this.open = true;
      this.failures = 0;
      this.emit('connected');
      void this.sendStatus();
      if (this.statusTimer) clearInterval(this.statusTimer);
      this.statusTimer = setInterval(() => void this.sendStatus(), this.opts.statusIntervalMs ?? 60_000);
    });
    ws.onMessage((text) => {
      if (ws !== this.ws) return;
      let msg: WsMessage;
      try {
        msg = JSON.parse(text) as WsMessage;
      } catch {
        this.log.warn('Mensagem WS inválida');
        return;
      }
      if (msg && typeof msg.type === 'string') this.emit('message', msg);
    });
    ws.onError((err) => this.log.warn('WebSocket', err.message));
    ws.onClose((code, reason) => {
      if (ws !== this.ws) return;
      this.ws = null;
      const wasOpen = this.open;
      this.open = false;
      if (this.statusTimer) clearInterval(this.statusTimer);
      this.statusTimer = null;
      if (wasOpen) this.emit('disconnected');
      if (!this.running) return;
      if (code === WS_CLOSE.UPGRADE_REQUIRED) {
        // Versão recusada pela API (§9): reconectar não muda nada até o app ser atualizado.
        this.log.warn('WebSocket recusado: esta versão do Arkivo para PC precisa ser atualizada');
        this.running = false;
        this.emit('upgradeRequired', { ...parseUpgradeCloseReason(reason ?? ''), kind: 'pc' });
        this.emit('stopped');
        return;
      }
      if (code === WS_CLOSE.BAD_CLIENT) this.log.error(`WebSocket recusado (${code}): cabeçalho de versão inválido`);
      this.log.info(`WebSocket fechado (${code}); reconectando`);
      if (code === WS_CLOSE.UNAUTHORIZED || code === WS_CLOSE.REVOKED) this.authClosed = true;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.failures++;
    const delay = this.backoffDelay(this.failures);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.running) return;
      const mustCheck = this.authClosed;
      this.authClosed = false;
      if (this.opts.beforeReconnect && (this.failures > 1 || mustCheck)) {
        let proceed = true;
        try {
          proceed = await this.opts.beforeReconnect();
        } catch {
          proceed = true;
        }
        if (!proceed) {
          this.running = false;
          this.emit('stopped');
          return;
        }
      }
      this.connect();
    }, delay);
  }
}
