// Interfaces injetáveis do core. Nada aqui depende do Electron, de `ws` ou de `qrcode`:
// o processo principal entrega os adaptadores reais e os testes usam fakes.

/** Cifra de segredos em repouso (no app: `safeStorage` do Electron). */
export interface SecretCipher {
  /** Nome gravado junto do segredo, para saber como decifrar depois. */
  readonly scheme: string;
  isAvailable(): boolean;
  /** Recebe texto puro e devolve texto (ex.: base64 do buffer cifrado). */
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** Sem cifra: usado nos testes e como último recurso quando o SO não oferece cofre. */
export const plainCipher: SecretCipher = {
  scheme: 'plain',
  isAvailable: () => true,
  encrypt: (s) => s,
  decrypt: (s) => s,
};

/** Conexão WebSocket mínima (o adaptador em `src/main` embrulha o pacote `ws`). */
export interface WsConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (text: string) => void): void;
  /** Chamado uma única vez quando a conexão termina (inclusive se nunca abriu). */
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

export type WsFactory = (url: string) => WsConnection;

/** Gera um data URL (PNG) com o QR Code do texto. */
export type QrEncoder = (text: string) => Promise<string>;

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (...a) => console.log('[arkivo]', ...a),
  warn: (...a) => console.warn('[arkivo]', ...a),
  error: (...a) => console.error('[arkivo]', ...a),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export type Clock = () => number;
