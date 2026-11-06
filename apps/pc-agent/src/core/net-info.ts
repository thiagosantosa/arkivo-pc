import os from 'node:os';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** IPv4 privado (RFC 1918): 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(addr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

type Ifaces = ReturnType<typeof os.networkInterfaces>;

/** Endereços IPv4 privados das interfaces ativas (sem loopback), sem repetição. */
export function lanIPv4Addresses(ifaces: Ifaces = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      const fam = info.family as string | number;
      const isV4 = fam === 'IPv4' || fam === 4;
      if (isV4 && !info.internal && isPrivateIPv4(info.address)) out.add(info.address);
    }
  }
  return [...out];
}

/** Espaço livre (bytes disponíveis ao usuário) no volume que contém `dir` ou seu ancestral mais próximo. */
export async function freeBytes(dir: string): Promise<number> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const s = await fsp.statfs(current);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code === 'ENOENT' || code === 'ENOTDIR') && parent !== current) {
        current = parent;
        continue;
      }
      throw err;
    }
  }
}
