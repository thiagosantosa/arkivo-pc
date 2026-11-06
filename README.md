# Arkivo para PC

Programa do computador (Electron 45): recebe os backups do celular, organiza em `AAAA/MM`, libera pastas para o
celular acessar e envia arquivos para o celular.

Os outros repositórios: [`arkivo-api`](https://github.com/thiagosantosa/arkivo-api) e
[`arkivo-front`](https://github.com/thiagosantosa/arkivo-front).

> Este repositório é gerado a partir do monorepo `arkivo` (script `scripts/export-repos.mjs`). O código compartilhado
> (`packages/shared`) é uma cópia: mudanças nele devem ser feitas no monorepo e exportadas para os três repositórios.

## Rodar localmente

```bash
npm install            # com npm 11, rode depois: node node_modules/electron/install.js
npm run dev            # abre o programa apontando para http://localhost:3000
npm test
```

Para apontar para a API publicada: `ARKIVO_API_URL=https://arkivo-api.onrender.com npm run dev`.

Rodando a partir do terminal do VS Code, o Electron abre como Node e fecha na hora: o VS Code define
`ELECTRON_RUN_AS_NODE=1`. Rode `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) antes.

## Publicar o instalador (GitHub Actions)

1. *Settings → Secrets and variables → Actions → Variables → New repository variable*:
   `ARKIVO_API_URL` = endereço da API (ex.: `https://arkivo-api.onrender.com`).
2. *Actions → "Release do Windows" → Run workflow*, informando a versão (ex.: `0.1.0`).
3. A Release fica em *Releases*, com dois arquivos iguais: `Arkivo-para-PC-Setup-<versão>.exe` e
   `Arkivo-para-PC-Setup.exe` (nome fixo para o link da última versão):
   `https://github.com/thiagosantosa/arkivo-pc/releases/latest/download/Arkivo-para-PC-Setup.exe`
4. Coloque esse link em `ARKIVO_DESKTOP_URL` no projeto `arkivo-front` (Vercel) e faça um *Redeploy*.

**Atenção:** se este repositório for **privado**, o link só funciona para quem tem acesso a ele no GitHub. Para os
testadores baixarem, deixe o repositório público ou hospede o instalador em outro lugar público.

Também dá para gerar o instalador nesta máquina:
`ARKIVO_BUILD_API_URL=https://arkivo-api.onrender.com npm run dist:win` → `apps/pc-agent/release/`.

O instalador ainda não é assinado: o Windows mostra "O Windows protegeu o computador" → **Mais informações →
Executar assim mesmo**.
