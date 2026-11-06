// Adaptadores reais para as interfaces do core (Electron, `ws`, `qrcode`).
import { safeStorage } from 'electron';
import QRCode from 'qrcode';
import WebSocket from 'ws';
import type { QrEncoder, SecretCipher, WsConnection, WsFactory } from '../core/types';

/** Cofre do SO via `safeStorage` (DPAPI no Windows, Keychain no macOS, libsecret no Linux). */
export const safeStorageCipher: SecretCipher = {
  scheme: 'safeStorage',
  isAvailable: () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      // No Linux sem chaveiro o Electron cai para "basic_text" (sem proteção real).
      if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text';
      }
      return true;
    } catch {
      return false;
    }
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
};

export const wsFactory: WsFactory = (url: string): WsConnection => {
  const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
  let closed = false;
  let closeCb: (code: number, reason: string) => void = () => {};
  const fireClose = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    closeCb(code, reason);
  };
  ws.on('close', (code, reason) => fireClose(code, reason.toString()));
  // 401/403 no upgrade não emite "close" em todas as versões; tratamos como fechamento.
  ws.on('unexpected-response', (_req, res) => {
    fireClose(res.statusCode === 401 ? 4401 : 1006, `HTTP ${res.statusCode}`);
    ws.terminate();
  });
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: (code, reason) => {
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(code ?? 1000, reason);
      } catch {
        /* ignore */
      }
    },
    onOpen: (cb) => {
      ws.on('open', cb);
    },
    onMessage: (cb) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) cb(data.toString());
      });
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    onError: (cb) => {
      ws.on('error', cb);
    },
  };
};

export const qrEncoder: QrEncoder = (text) =>
  QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 480,
    color: { dark: '#161826ff', light: '#f3f5feff' },
  });
