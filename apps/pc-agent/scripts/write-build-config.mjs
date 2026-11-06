// Grava (ou apaga) dist/main/build-config.json com o endereço da API embutido no instalador.
//   node scripts/write-build-config.mjs http://localhost:3000   → instalador de teste (API neste PC)
//   node scripts/write-build-config.mjs                         → sem arquivo: usa https://api.arkivo.com
// No app, ARKIVO_API_URL no ambiente continua tendo prioridade (veja resolveApiUrl em src/main/main.ts).
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main', 'build-config.json');
const apiUrl = process.argv[2] ?? process.env.ARKIVO_BUILD_API_URL;

if (!apiUrl) {
  rmSync(file, { force: true });
  console.log('[build-config] sem API embutida (padrão https://api.arkivo.com)');
} else {
  if (!/^https?:\/\/[^\s]+$/.test(apiUrl)) {
    console.error(`[build-config] URL inválida: ${apiUrl}`);
    process.exit(1);
  }
  writeFileSync(file, JSON.stringify({ apiUrl: apiUrl.replace(/\/+$/, '') }, null, 2) + '\n');
  console.log(`[build-config] API embutida: ${apiUrl}`);
}
