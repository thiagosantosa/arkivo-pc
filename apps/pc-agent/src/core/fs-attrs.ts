// Pastas liberadas: atributos do Windows que o Node não expõe (§10.4 "oculto", §10.11 OneDrive "somente online").
// Usa o `dir` do próprio cmd.exe com `/u` (saída em UTF-16, nomes com acento chegam certos) e a pasta como
// diretório de trabalho (nenhum caminho passa pela linha de comando, então não há interpretação de `%` ou aspas).
import { execFile } from 'node:child_process';

export interface DirAttributes {
  /** Nomes com o atributo "oculto". */
  hidden: Set<string>;
  /** Nomes com o atributo "offline" (arquivos do OneDrive só na nuvem): ler dispara o download, então sem miniatura. */
  offline: Set<string>;
}

export type DirAttributeProbe = (absDir: string) => Promise<DirAttributes>;

export const noDirAttributes: DirAttributeProbe = () => Promise.resolve({ hidden: new Set(), offline: new Set() });

const SEP = '::arkivo::';

/** Divide a saída UTF-16 do `cmd /u` (`dir /a:h /b`, separador, `dir /a:o /b`). */
export function parseDirAttributesOutput(text: string): DirAttributes {
  const [h = '', o = ''] = text.split(SEP);
  const names = (s: string) =>
    new Set(
      s
        .split(/\r?\n/)
        .map((l) => l.trim().normalize('NFC'))
        .filter((l) => l && l !== SEP),
    );
  return { hidden: names(h), offline: names(o) };
}

/** Probe real do Windows (em outros sistemas não há atributo oculto: vale o `.` no começo do nome). */
export const windowsDirAttributes: DirAttributeProbe = (absDir) =>
  new Promise((resolve) => {
    execFile(
      'cmd.exe',
      ['/d', '/u', '/c', `dir /a:h /b 2>nul & echo ${SEP} & dir /a:o /b 2>nul`],
      { cwd: absDir, encoding: 'buffer', timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (_err, stdout) => {
        // `dir` sem resultado sai com código 1: não é erro para nós.
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
        // O `echo` sai em UTF-16 também (cmd /u); se algo vier em 8 bits, cai no texto vazio (sem atributos).
        const text = buf.length % 2 === 0 ? buf.toString('utf16le') : '';
        resolve(text.includes(SEP) ? parseDirAttributesOutput(text) : { hidden: new Set(), offline: new Set() });
      },
    );
  });
