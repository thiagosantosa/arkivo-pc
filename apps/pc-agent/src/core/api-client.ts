import type {
  ApiError as ApiErrorBody,
  CreateFsBlobRequest,
  CreatePairingRequest,
  CreatePairingResponse,
  Device,
  FileRecord,
  FsBlobInfo,
  LocationReport,
  PairingPollResponse,
  PcSelfUpdate,
  PeerPhoneInfo,
  Transfer,
  UpgradeRequiredInfo,
} from '@arkivo/shared';
import { CLIENT_HEADER_NAMES, CLIENT_QUERY, PROTOCOL_VERSION, UPGRADE_REQUIRED_STATUS, formatClientHeader, parseUpgradeRequired } from '@arkivo/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Preenchido no `426 UPGRADE_REQUIRED` (contrato §9). */
    readonly upgrade: UpgradeRequiredInfo | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Erro de rede ou do servidor (vale tentar de novo depois). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** A API recusou esta versão do app ou do protocolo: não adianta tentar de novo. */
  get upgradeRequired(): boolean {
    return this.upgrade !== null;
  }
}

export type FetchLike = typeof fetch;

export interface ApiClientOptions {
  /** Origem da API, ex.: `https://api.arkivo.com` (o cliente acrescenta `/v1/...`). */
  baseUrl: string;
  getDeviceToken: () => string | null;
  fetchImpl?: FetchLike;
  /** Tempo limite das chamadas JSON (downloads não têm limite). */
  timeoutMs?: number;
  userAgent?: string;
  /** Versão do app (semver). Vai em `X-Arkivo-Client: pc/<versão>` e na query do WebSocket (contrato §9). */
  clientVersion?: string;
  /** Chamado a cada `426 UPGRADE_REQUIRED` da API (o agente entra em `updateRequired`). */
  onUpgradeRequired?: (info: UpgradeRequiredInfo) => void;
}

interface RequestOpts {
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly clientHeader: string | null;

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.clientHeader = opts.clientVersion ? formatClientHeader('pc', opts.clientVersion) : null;
  }

  /** `X-Arkivo-Client` e `X-Arkivo-Protocol`, em toda requisição à API (contrato §9). */
  versionHeaders(): Record<string, string> {
    const h: Record<string, string> = { [CLIENT_HEADER_NAMES.protocol]: String(PROTOCOL_VERSION) };
    if (this.clientHeader) h[CLIENT_HEADER_NAMES.client] = this.clientHeader;
    return h;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  url(pathname: string): string {
    return new URL(pathname, this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : this.opts.baseUrl + '/').toString();
  }

  /**
   * URL do WebSocket `/v1/ws` com os parâmetros de query. Leva também `client` e `protocol` (contrato §9):
   * o `WsFactory` só recebe a URL, e a API aceita a versão pela query quando não há cabeçalho.
   */
  wsUrl(params: Record<string, string>): string {
    const u = new URL(this.url('v1/ws'));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (this.clientHeader) u.searchParams.set(CLIENT_QUERY.client, this.clientHeader);
    u.searchParams.set(CLIENT_QUERY.protocol, String(PROTOCOL_VERSION));
    return u.toString();
  }

  // ---------- Pareamento (sem auth) ----------
  createPairing(req: CreatePairingRequest): Promise<CreatePairingResponse> {
    return this.json('POST', 'v1/pairings', { body: req, auth: false });
  }

  pollPairing(pairingId: string, pollToken: string): Promise<PairingPollResponse> {
    const q = new URLSearchParams({ pollToken }).toString();
    return this.json('GET', `v1/pairings/${encodeURIComponent(pairingId)}?${q}`, { auth: false });
  }

  // ---------- Dispositivo PC ----------
  getSelf(): Promise<Device> {
    return this.json('GET', 'v1/devices/pc/self');
  }

  patchSelf(update: PcSelfUpdate): Promise<Device> {
    return this.json('PATCH', 'v1/devices/pc/self', { body: update });
  }

  getPeers(): Promise<{ phones: PeerPhoneInfo[] }> {
    return this.json('GET', 'v1/devices/pc/peers');
  }

  logout(): Promise<void> {
    return this.json('POST', 'v1/devices/pc/logout');
  }

  // ---------- Arquivos ----------
  reportLocation(fileId: string, report: LocationReport): Promise<FileRecord> {
    return this.json('POST', `v1/files/${encodeURIComponent(fileId)}/locations`, { body: report });
  }

  // ---------- Relay ----------
  relayPending(): Promise<Transfer[]> {
    return this.json('GET', 'v1/relay/pending');
  }

  /** Abre o download do spool. `offset > 0` envia `Range: bytes=<offset>-`. O chamador trata 200/206/416. */
  async relayDownload(transferId: string, offset: number, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { ...this.versionHeaders(), ...this.authHeaders() };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(`v1/relay/${encodeURIComponent(transferId)}/download`), {
        method: 'GET',
        headers,
        signal,
      });
    } catch (err) {
      throw networkError(err);
    }
    if (res.ok || res.status === 416) return res;
    throw await this.toError(res);
  }

  relayAck(transferId: string, report: LocationReport): Promise<void> {
    return this.json('POST', `v1/relay/${encodeURIComponent(transferId)}/ack`, { body: report });
  }

  relayFail(transferId: string, reason: string): Promise<void> {
    return this.json('POST', `v1/relay/${encodeURIComponent(transferId)}/fail`, { body: { reason } });
  }

  // ---------- Pastas liberadas: blobs cifrados no spool (contrato §10.7) ----------
  /** `POST /v1/fs-blobs { cipherSize }` (PC → blob `toPhone`). */
  createFsBlob(req: CreateFsBlobRequest): Promise<FsBlobInfo> {
    return this.json('POST', 'v1/fs-blobs', { body: req });
  }

  getFsBlob(blobId: string): Promise<FsBlobInfo> {
    return this.json('GET', `v1/fs-blobs/${encodeURIComponent(blobId)}`);
  }

  /** `DELETE /v1/fs-blobs/:id`: destinatário = "recebi"; criador = cancelar. Idempotente. */
  deleteFsBlob(blobId: string): Promise<void> {
    return this.json('DELETE', `v1/fs-blobs/${encodeURIComponent(blobId)}`);
  }

  failFsBlob(blobId: string, reason: string): Promise<void> {
    return this.json('POST', `v1/fs-blobs/${encodeURIComponent(blobId)}/fail`, { body: { reason } });
  }

  /** `HEAD /v1/fs-blobs/:id/content` → `X-Arkivo-Received` (0 se nada). */
  async headFsBlobContent(blobId: string): Promise<number> {
    const res = await this.raw('HEAD', `v1/fs-blobs/${encodeURIComponent(blobId)}/content`, {}, undefined, AbortSignal.timeout(this.timeoutMs));
    if (!res.ok) throw await this.toError(res);
    const n = Number(res.headers.get('x-arkivo-received') ?? 0);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  /**
   * `PUT /v1/fs-blobs/:id/content` (regras do §4.1). Devolve o status (200 pronto, 202 pedaço aceito, 416 buraco,
   * 423 ocupado) e o `X-Arkivo-Received`; os demais viram `ApiError`. `single` = o blob cabe num pedaço (vai sem
   * `Content-Range`).
   */
  async putFsBlobChunk(
    blobId: string,
    data: Uint8Array,
    o: { start: number; total: number; hash: string; single: boolean; signal?: AbortSignal },
  ): Promise<{ status: number; received: number | null }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Arkivo-Hash': o.hash };
    if (!o.single) headers['Content-Range'] = `bytes ${o.start}-${o.start + data.length - 1}/${o.total}`;
    const res = await this.raw('PUT', `v1/fs-blobs/${encodeURIComponent(blobId)}/content`, headers, data, o.signal ?? AbortSignal.timeout(5 * 60_000));
    if (res.ok || res.status === 416 || res.status === 423) {
      await res.body?.cancel().catch(() => undefined);
      const h = res.headers.get('x-arkivo-received');
      return { status: res.status, received: h === null ? null : Number(h) };
    }
    throw await this.toError(res);
  }

  /** `GET /v1/fs-blobs/:id/content` com `Range: bytes=<offset>-` quando `offset > 0`. O chamador trata 200/206/416. */
  async downloadFsBlob(blobId: string, offset: number, signal?: AbortSignal): Promise<Response> {
    const res = await this.raw('GET', `v1/fs-blobs/${encodeURIComponent(blobId)}/content`, offset > 0 ? { Range: `bytes=${offset}-` } : {}, undefined, signal);
    if (res.ok || res.status === 416) return res;
    throw await this.toError(res);
  }

  // ---------- infra ----------
  private async raw(method: string, pathname: string, extra: Record<string, string>, body: Uint8Array | undefined, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { ...this.versionHeaders(), ...this.authHeaders(), ...extra };
    if (!headers.Authorization) throw new ApiError(401, 'UNAUTHORIZED', 'Este PC não está pareado');
    try {
      return await this.fetchImpl(this.url(pathname), { method, headers, body: body as Uint8Array<ArrayBuffer> | undefined, signal });
    } catch (err) {
      throw networkError(err);
    }
  }

  private authHeaders(): Record<string, string> {
    const token = this.opts.getDeviceToken();
    const h: Record<string, string> = {};
    if (token) h.Authorization = `Device ${token}`;
    if (this.opts.userAgent) h['User-Agent'] = this.opts.userAgent;
    return h;
  }

  private async json<T>(method: string, pathname: string, o: RequestOpts = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.versionHeaders(), ...(o.headers ?? {}) };
    if (o.auth !== false) {
      const auth = this.authHeaders();
      if (!auth.Authorization) throw new ApiError(401, 'UNAUTHORIZED', 'Este PC não está pareado');
      Object.assign(headers, auth);
    } else if (this.opts.userAgent) {
      headers['User-Agent'] = this.opts.userAgent;
    }
    let body: string | undefined;
    if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    const signal = o.signal ?? AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(pathname), { method, headers, body, signal });
    } catch (err) {
      throw networkError(err);
    }
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async toError(res: Response): Promise<ApiError> {
    const err = await toApiError(res);
    if (err.upgrade) {
      try {
        this.opts.onUpgradeRequired?.(err.upgrade);
      } catch {
        /* quem assina trata os próprios erros */
      }
    }
    return err;
  }
}

function networkError(err: unknown): ApiError {
  const msg = err instanceof Error ? err.message : String(err);
  return new ApiError(0, 'NETWORK', `Sem conexão com o servidor (${msg})`);
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = 'INTERNAL';
  let message = `HTTP ${res.status}`;
  let upgrade: UpgradeRequiredInfo | null = null;
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    if (res.status === UPGRADE_REQUIRED_STATUS) upgrade = parseUpgradeRequired(body);
  } catch {
    /* corpo não-JSON */
  }
  // 426 sem o corpo do contrato (proxy, versão futura da API): continua sendo "atualize o app".
  if (res.status === UPGRADE_REQUIRED_STATUS && !upgrade) upgrade = { minVersion: null, kind: 'pc', protocol: PROTOCOL_VERSION };
  if (upgrade) code = 'UPGRADE_REQUIRED';
  return new ApiError(res.status, code, message, upgrade);
}
