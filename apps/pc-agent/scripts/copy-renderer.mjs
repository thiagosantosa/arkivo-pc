// Copia HTML/CSS do renderer para dist/ e embute fontes/ícones (Inter + Phosphor) localmente,
// para o app funcionar offline e com CSP sem rede.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'renderer');
const require = createRequire(path.join(root, 'package.json'));
mkdirSync(out, { recursive: true });

for (const f of ['index.html', 'styles.css']) copyFileSync(path.join(root, 'src', 'renderer', f), path.join(out, f));

/** Pasta do pacote. Procura nos node_modules acima (workspaces sobem os pacotes para a raiz) sem depender de "exports". */
function pkgDir(name) {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

/** Copia um CSS e todos os arquivos referenciados em url(...) (fontes). */
function vendorCss(srcCssList, destDir, destName) {
  mkdirSync(destDir, { recursive: true });
  let combined = '';
  for (const srcCss of srcCssList) {
    const css = readFileSync(srcCss, 'utf8');
    const rewritten = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, _q, ref) => {
      if (/^(data:|https?:)/.test(ref)) return m;
      const clean = ref.split(/[?#]/)[0];
      const from = path.resolve(path.dirname(srcCss), clean);
      if (!existsSync(from)) return m;
      const base = path.basename(clean);
      copyFileSync(from, path.join(destDir, base));
      return `url("./${base}")`;
    });
    combined += rewritten + '\n';
  }
  writeFileSync(path.join(destDir, destName), combined);
}

const phosphor = pkgDir('@phosphor-icons/web');
if (phosphor) {
  vendorCss([path.join(phosphor, 'src', 'regular', 'style.css')], path.join(out, 'vendor', 'phosphor'), 'style.css');
} else {
  console.warn('[copy-renderer] @phosphor-icons/web não encontrado: ícones não serão exibidos.');
  mkdirSync(path.join(out, 'vendor', 'phosphor'), { recursive: true });
  writeFileSync(path.join(out, 'vendor', 'phosphor', 'style.css'), '/* @phosphor-icons/web ausente */\n');
}

const inter = pkgDir('@fontsource/inter');
if (inter) {
  // Só latin + latin-ext (pt-BR) para manter o instalador pequeno.
  const pick = (weight) => {
    const css = readFileSync(path.join(inter, `${weight}.css`), 'utf8');
    const blocks = css.split('@font-face').filter((b) => /latin(-ext)?-\d+-normal/.test(b) && !/(cyrillic|greek|vietnamese)/.test(b));
    const tmp = path.join(out, `.inter-${weight}.css`);
    writeFileSync(tmp, blocks.map((b) => '@font-face' + b.replace(/\/\*[^*]*\*\/\s*$/, '')).join('\n'));
    return tmp;
  };
  const files = [pick(400), pick(500)].map((tmp) => {
    // reescreve as URLs relativas ao pacote original
    const css = readFileSync(tmp, 'utf8').replace(/url\(\.\/files\//g, `url(${path.join(inter, 'files').replace(/\\/g, '/')}/`);
    writeFileSync(tmp, css);
    return tmp;
  });
  vendorCss(files, path.join(out, 'vendor', 'inter'), 'inter.css');
  files.forEach((f) => rmSync(f, { force: true }));
} else {
  console.warn('[copy-renderer] @fontsource/inter não encontrado: usando fonte do sistema.');
  mkdirSync(path.join(out, 'vendor', 'inter'), { recursive: true });
  writeFileSync(path.join(out, 'vendor', 'inter', 'inter.css'), '/* @fontsource/inter ausente */\n');
}
console.log('[copy-renderer] ok →', path.relative(root, out));
