// Arkivo — versionamento de protocolo e de cliente (contrato §9). Sem dependências: roda na API,
// no PC (Node/Electron) e no celular (Angular/WebView).

/**
 * Versão do protocolo entre as partes (inteiro). Sobe só em mudança **incompatível** do contrato
 * (política no §9.5 do contrato). Mudanças compatíveis (campo novo opcional, rota nova) não sobem.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Protocolo mais antigo que esta versão ainda aceita do outro lado. Cada build aceita pares com
 * protocolo entre `MIN_PROTOCOL_VERSION` e `PROTOCOL_VERSION` (inclusive).
 */
export const MIN_PROTOCOL_VERSION = 1;

/** Protocolo assumido quando o outro lado não informa nenhum (builds anteriores ao §9 falam o protocolo 1). */
export const LEGACY_PROTOCOL_VERSION = 1;

/** Nomes dos cabeçalhos HTTP (forma canônica, para enviar e para listas de CORS). */
export const CLIENT_HEADER_NAMES = {
  client: 'X-Arkivo-Client',
  protocol: 'X-Arkivo-Protocol',
} as const;

/** Os mesmos cabeçalhos em minúsculas (como o Node entrega em `req.headers`). */
export const CLIENT_HEADERS = {
  client: 'x-arkivo-client',
  protocol: 'x-arkivo-protocol',
} as const;

/** Parâmetros de query equivalentes, para o WebSocket (o navegador não deixa mandar cabeçalho no upgrade). */
export const CLIENT_QUERY = {
  client: 'client',
  protocol: 'protocol',
} as const;

export type ClientKind = 'pc' | 'mobile';
export const CLIENT_KINDS: readonly ClientKind[] = ['pc', 'mobile'];

export interface ClientInfo {
  kind: ClientKind;
  /** Semver do app (`MAJOR.MINOR.PATCH`, opcionalmente `-pre` e `+build`). */
  version: string;
}

// ------------------------------------------------------------------ semver simples

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Identificadores da pré-versão (`1.0.0-beta.2` → `['beta', '2']`). Vazio numa versão final. */
  prerelease: string[];
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const MAX_VERSION_LENGTH = 64;

/** Lê um semver (`1.2.3`, `1.2.3-beta.1`, `1.2.3+abc`). Retorna `null` se não for válido. */
export function parseSemver(value: string): Semver | null {
  if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH) return null;
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (!nums.every(Number.isSafeInteger)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease: m[4] ? m[4].split('.') : [] };
}

export function isSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

/**
 * Compara dois semver: `-1` se `a < b`, `0` se iguais, `1` se `a > b`.
 * Segue a precedência do semver.org: pré-versão vem antes da final (`1.0.0-beta < 1.0.0`)
 * e o `+build` é ignorado. Lança erro se algum dos dois for inválido.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`Versão inválida: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return comparePrerelease(x.prerelease, y.prerelease);
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    if (a[i] === b[i]) continue;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1; // numérico vem antes de alfanumérico
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** `version >= min`. */
export function isVersionAtLeast(version: string, min: string): boolean {
  return compareSemver(version, min) >= 0;
}

// ------------------------------------------------------------------ cabeçalhos

/** Monta o valor de `X-Arkivo-Client` (`pc/0.1.0`, `mobile/1.2.0`). Lança erro se a versão não for semver. */
export function formatClientHeader(kind: ClientKind, version: string): string {
  if (!CLIENT_KINDS.includes(kind)) throw new Error(`Tipo de cliente inválido: ${kind}`);
  if (!isSemver(version)) throw new Error(`Versão inválida para ${CLIENT_HEADER_NAMES.client}: ${version}`);
  return `${kind}/${version.trim()}`;
}

/** Interpreta `X-Arkivo-Client`. Retorna `null` se estiver malformado (tipo desconhecido ou versão fora do semver). */
export function parseClientHeader(value: string): ClientInfo | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const slash = v.indexOf('/');
  if (slash <= 0) return null;
  const kind = v.slice(0, slash).toLowerCase();
  const version = v.slice(slash + 1);
  if (!(CLIENT_KINDS as readonly string[]).includes(kind) || !isSemver(version)) return null;
  return { kind: kind as ClientKind, version };
}

/** Interpreta `X-Arkivo-Protocol` (inteiro positivo em decimal). Retorna `null` se malformado. */
export function parseProtocolHeader(value: string): number | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^[1-9]\d{0,5}$/.test(v)) return null;
  return Number(v);
}

/** Cabeçalhos que todo cliente manda (API, servidor LAN do PC). */
export function clientHeaders(kind: ClientKind, version: string, protocol = PROTOCOL_VERSION): Record<string, string> {
  return {
    [CLIENT_HEADER_NAMES.client]: formatClientHeader(kind, version),
    [CLIENT_HEADER_NAMES.protocol]: String(protocol),
  };
}

/** Os mesmos valores como query (`client=pc%2F0.1.0&protocol=1`), para o WebSocket. */
export function clientQuery(kind: ClientKind, version: string, protocol = PROTOCOL_VERSION): Record<string, string> {
  return {
    [CLIENT_QUERY.client]: formatClientHeader(kind, version),
    [CLIENT_QUERY.protocol]: String(protocol),
  };
}

export interface ProtocolRange {
  min: number;
  max: number;
}

export const SUPPORTED_PROTOCOLS: ProtocolRange = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION };

/** O protocolo do outro lado está na faixa que esta versão fala? */
export function isProtocolSupported(peer: number, range: ProtocolRange = SUPPORTED_PROTOCOLS): boolean {
  return Number.isInteger(peer) && peer >= range.min && peer <= range.max;
}

/** Protocolo informado por um par (`/v1/ping`, `/v1/health`); ausente = protocolo legado (1). */
export function peerProtocol(value: unknown): number | null {
  if (value === undefined || value === null) return LEGACY_PROTOCOL_VERSION;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

// ------------------------------------------------------------------ resposta 426

/** Dados do `426 UPGRADE_REQUIRED` (HTTP) e do fechamento `4426` do WebSocket. */
export interface UpgradeRequiredInfo {
  /** Versão mínima aceita para o `kind` do cliente; `null` se o servidor não exige uma (ex.: servidor LAN do PC). */
  minVersion: string | null;
  /** Tipo do cliente recusado; `null` se ele não mandou `X-Arkivo-Client`. */
  kind: ClientKind | null;
  /** Protocolo que o servidor fala (`PROTOCOL_VERSION` dele). */
  protocol: number;
}

/** Corpo do `426`: mesmo formato de erro da API, com os campos de `UpgradeRequiredInfo` dentro de `error`. */
export interface UpgradeRequiredBody {
  error: { code: 'UPGRADE_REQUIRED'; message: string } & UpgradeRequiredInfo;
}

export const UPGRADE_REQUIRED_STATUS = 426;

/**
 * Mensagem pt-BR para o usuário. Com `reason: 'protocol'` a versão mínima não é citada
 * (o app pode já estar acima dela; o que mudou foi o protocolo).
 */
export function upgradeMessage(info: Pick<UpgradeRequiredInfo, 'kind' | 'minVersion'>, reason: 'version' | 'protocol' = 'version'): string {
  const app = info.kind === 'pc' ? 'o Arkivo para PC' : 'o Arkivo';
  if (reason === 'protocol') return `Esta versão não é mais compatível com o servidor. Atualize ${app} para a versão mais recente.`;
  return info.minVersion
    ? `Esta versão não é mais aceita. Atualize ${app} para a versão ${info.minVersion} ou mais nova.`
    : `Esta versão não é mais aceita. Atualize ${app} para a versão mais recente.`;
}

export function upgradeRequiredBody(info: UpgradeRequiredInfo): UpgradeRequiredBody {
  return { error: { code: 'UPGRADE_REQUIRED', message: upgradeMessage(info), ...info } };
}

/** Lê o corpo de um `426` (tolerante: qualquer campo ausente vira `null`). */
export function parseUpgradeRequired(body: unknown): UpgradeRequiredInfo | null {
  if (!body || typeof body !== 'object') return null;
  const e = (body as { error?: unknown }).error;
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'UPGRADE_REQUIRED') return null;
  return normalizeUpgradeInfo(e);
}

/** Texto do `reason` no fechamento `4426` do WebSocket: JSON de `UpgradeRequiredInfo` (cabe nos 123 bytes do frame). */
export function formatUpgradeCloseReason(info: UpgradeRequiredInfo): string {
  return JSON.stringify({ minVersion: info.minVersion, kind: info.kind, protocol: info.protocol });
}

export function parseUpgradeCloseReason(reason: string): UpgradeRequiredInfo {
  try {
    return normalizeUpgradeInfo(JSON.parse(reason)) ?? emptyUpgradeInfo();
  } catch {
    return emptyUpgradeInfo();
  }
}

function emptyUpgradeInfo(): UpgradeRequiredInfo {
  return { minVersion: null, kind: null, protocol: PROTOCOL_VERSION };
}

function normalizeUpgradeInfo(v: unknown): UpgradeRequiredInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    minVersion: typeof o.minVersion === 'string' && isSemver(o.minVersion) ? o.minVersion : null,
    kind: o.kind === 'pc' || o.kind === 'mobile' ? o.kind : null,
    protocol: typeof o.protocol === 'number' && Number.isInteger(o.protocol) ? o.protocol : PROTOCOL_VERSION,
  };
}

// ------------------------------------------------------------------ decisão do servidor

export interface ClientCompatInput {
  /** Valor de `X-Arkivo-Client` (ou da query `client`), se veio. */
  client?: string | null;
  /** Valor de `X-Arkivo-Protocol` (ou da query `protocol`), se veio. */
  protocol?: string | null;
}

export interface ClientCompatPolicy {
  /** Versão mínima por tipo de cliente. Tipo sem mínimo = qualquer versão. */
  minVersions?: Partial<Record<ClientKind, string>>;
  /** Faixa de protocolo aceita (padrão: a desta build). */
  protocols?: ProtocolRange;
  /** Protocolo informado no 426 (padrão: `PROTOCOL_VERSION`). */
  serverProtocol?: number;
}

export type ClientCompat =
  /** Aceito. `missing` = não veio nenhum dos dois cabeçalhos (ferramentas, monitoramento, builds antigas). */
  | { status: 'ok'; client: ClientInfo | null; protocol: number | null; missing: boolean }
  /** Cabeçalho presente mas malformado → `400 VALIDATION_ERROR`. */
  | { status: 'invalid'; header: (typeof CLIENT_HEADER_NAMES)[keyof typeof CLIENT_HEADER_NAMES]; message: string }
  /** Versão abaixo do mínimo ou protocolo fora da faixa → `426 UPGRADE_REQUIRED`. */
  | { status: 'upgrade'; reason: 'version' | 'protocol'; info: UpgradeRequiredInfo; client: ClientInfo | null; protocol: number | null };

/**
 * Regra única de aceitação de cliente (API em HTTP e WebSocket; servidor LAN do PC):
 * - sem cabeçalho → aceita;
 * - cabeçalho malformado → `invalid`;
 * - protocolo fora da faixa aceita → `upgrade` (`reason: 'protocol'`);
 * - versão abaixo do mínimo do seu tipo → `upgrade` (`reason: 'version'`).
 */
export function checkClientCompat(input: ClientCompatInput, policy: ClientCompatPolicy = {}): ClientCompat {
  const rawClient = input.client?.trim() || null;
  const rawProtocol = input.protocol?.trim() || null;
  const client = rawClient ? parseClientHeader(rawClient) : null;
  if (rawClient && !client) {
    return {
      status: 'invalid',
      header: CLIENT_HEADER_NAMES.client,
      message: `Cabeçalho ${CLIENT_HEADER_NAMES.client} inválido (formato esperado: pc/1.2.3 ou mobile/1.2.3).`,
    };
  }
  const protocol = rawProtocol ? parseProtocolHeader(rawProtocol) : null;
  if (rawProtocol && protocol === null) {
    return { status: 'invalid', header: CLIENT_HEADER_NAMES.protocol, message: `Cabeçalho ${CLIENT_HEADER_NAMES.protocol} inválido (inteiro positivo).` };
  }
  const minVersion = client ? (policy.minVersions?.[client.kind] ?? null) : null;
  const info: UpgradeRequiredInfo = {
    minVersion,
    kind: client?.kind ?? null,
    protocol: policy.serverProtocol ?? PROTOCOL_VERSION,
  };
  if (protocol !== null && !isProtocolSupported(protocol, policy.protocols ?? SUPPORTED_PROTOCOLS)) {
    return { status: 'upgrade', reason: 'protocol', info, client, protocol };
  }
  if (client && minVersion && !isVersionAtLeast(client.version, minVersion)) {
    return { status: 'upgrade', reason: 'version', info, client, protocol };
  }
  return { status: 'ok', client, protocol, missing: !rawClient && !rawProtocol };
}
