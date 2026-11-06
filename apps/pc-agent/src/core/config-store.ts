import path from 'node:path';
import { PC_LAN_PORT } from '@arkivo/shared';
import type { SharedRoot } from './fs-roots';
import { readJson, SerialQueue, writeFileAtomic } from './fs-utils';
import { Logger, SecretCipher, silentLogger } from './types';

export interface AccountInfo {
  name: string;
  handle: string;
  /** Ausente em configurações salvas antes da revisão de integração (2026-11-03). */
  email?: string;
}

export interface PeerPhone {
  id: string;
  name: string;
  /** Recursos do celular (ex.: `fs-push`, contrato §11). Ausente = API ou app antigo. */
  capabilities?: string[];
}

export interface StoredSecret {
  scheme: string;
  value: string;
}

/** Conteúdo de `config.json` (sem segredos em texto puro quando há cofre do SO). */
export interface AgentSettings {
  apiBaseUrl: string;
  storageDir: string | null;
  autostart: boolean;
  lanPort: number;
  pcName: string;
  deviceId: string | null;
  account: AccountInfo | null;
  /** Cache dos celulares do usuário — o modo direto continua funcionando se a internet cair. */
  phones: PeerPhone[];
  /** [2026-11-04] Pastas liberadas para o celular (§10.2) e o interruptor "Acesso pelo celular". */
  fsRoots: SharedRoot[];
  fsEnabled: boolean;
}

interface ConfigFile extends AgentSettings {
  version: 1;
  secrets: { deviceToken?: StoredSecret; pairKey?: StoredSecret };
}

export interface Credentials {
  deviceId: string;
  deviceToken: string;
  pairKey: string;
  account: AccountInfo;
}

export interface ConfigStoreOptions {
  /** Diretório de dados do app (no Electron: `app.getPath('userData')`). */
  dir: string;
  cipher: SecretCipher;
  defaults: Pick<AgentSettings, 'apiBaseUrl' | 'pcName'> & Partial<AgentSettings>;
  logger?: Logger;
}

export const CONFIG_FILE_NAME = 'config.json';

export class ConfigStore {
  private data!: ConfigFile;
  private secrets: { deviceToken: string | null; pairKey: string | null } = { deviceToken: null, pairKey: null };
  private readonly file: string;
  private readonly writes = new SerialQueue();
  private readonly log: Logger;

  constructor(private readonly opts: ConfigStoreOptions) {
    this.file = path.join(opts.dir, CONFIG_FILE_NAME);
    this.log = opts.logger ?? silentLogger;
  }

  get filePath(): string {
    return this.file;
  }

  async load(): Promise<void> {
    const stored = await readJson<Partial<ConfigFile>>(this.file);
    const d = this.opts.defaults;
    const base: AgentSettings = {
      apiBaseUrl: '',
      storageDir: null,
      autostart: true,
      lanPort: PC_LAN_PORT,
      pcName: '',
      deviceId: null,
      account: null,
      phones: [],
      fsRoots: [],
      fsEnabled: false,
    };
    this.data = {
      version: 1,
      ...base,
      ...d,
      ...(stored ?? {}),
      // A URL da API vem do build/ambiente (ARKIVO_API_URL); o arquivo só registra a usada.
      apiBaseUrl: d.apiBaseUrl,
      secrets: stored?.secrets ?? {},
    } as ConfigFile;
    this.secrets = {
      deviceToken: this.openSecret(this.data.secrets.deviceToken),
      pairKey: this.openSecret(this.data.secrets.pairKey),
    };
    if (!stored) await this.save();
  }

  get settings(): Readonly<AgentSettings> {
    const { secrets: _s, version: _v, ...rest } = this.data;
    return rest;
  }

  async update(patch: Partial<AgentSettings>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await this.save();
  }

  getCredentials(): Credentials | null {
    const { deviceId, account } = this.data;
    const { deviceToken, pairKey } = this.secrets;
    if (!deviceId || !account || !deviceToken || !pairKey) return null;
    return { deviceId, deviceToken, pairKey, account };
  }

  async setCredentials(c: Credentials): Promise<void> {
    this.secrets = { deviceToken: c.deviceToken, pairKey: c.pairKey };
    this.data = {
      ...this.data,
      deviceId: c.deviceId,
      account: c.account,
      secrets: { deviceToken: this.sealSecret(c.deviceToken), pairKey: this.sealSecret(c.pairKey) },
    };
    await this.save();
  }

  async clearCredentials(): Promise<void> {
    this.secrets = { deviceToken: null, pairKey: null };
    this.data = { ...this.data, deviceId: null, account: null, phones: [], secrets: {} };
    await this.save();
  }

  /** Indica se os segredos estão protegidos pelo cofre do SO. */
  get secretsProtected(): boolean {
    return this.opts.cipher.scheme !== 'plain' && this.opts.cipher.isAvailable();
  }

  private sealSecret(plain: string): StoredSecret {
    const { cipher } = this.opts;
    if (cipher.isAvailable()) {
      try {
        return { scheme: cipher.scheme, value: cipher.encrypt(plain) };
      } catch (err) {
        this.log.warn('Falha ao cifrar segredo; gravando sem cifra', err);
      }
    } else {
      this.log.warn('Cofre do sistema indisponível; segredos gravados sem cifra (arquivo com permissão 600).');
    }
    return { scheme: 'plain', value: plain };
  }

  private openSecret(s: StoredSecret | undefined): string | null {
    if (!s || typeof s.value !== 'string') return null;
    if (s.scheme === 'plain') return s.value;
    const { cipher } = this.opts;
    if (s.scheme !== cipher.scheme || !cipher.isAvailable()) {
      this.log.warn(`Segredo cifrado com "${s.scheme}" não pode ser aberto agora`);
      return null;
    }
    try {
      return cipher.decrypt(s.value);
    } catch (err) {
      this.log.warn('Falha ao decifrar segredo', err);
      return null;
    }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    return this.writes.run(() => writeFileAtomic(this.file, snapshot, 0o600, { logger: this.log }));
  }
}
