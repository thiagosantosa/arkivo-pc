# Engenharia — Arkivo

## Ambiente

- Node **22 LTS** (`.nvmrc`; `nvm use` / `fnm use`). A imagem Docker da API usa `node:22.x-alpine` com versão fixa.
- `npm ci` na raiz instala os quatro workspaces a partir do `package-lock.json`.
- Editor: respeite o `.editorconfig` (LF, UTF-8, 2 espaços; código nativo com 4).

## Verificações locais

| Comando                                 | O que faz                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run build:shared`                  | Compila `@arkivo/shared` (rode antes de lint/typecheck/testes).                                             |
| `npm run lint`                          | ESLint com tipos (`eslint.config.mjs`) em todos os workspaces e `tests/`. Precisa terminar com **0 erros**. |
| `npm run typecheck`                     | `tsc --noEmit` de api, pc-agent, mobile e `typecheck:logic` do mobile.                                      |
| `npm test` / `npm run test:integration` | Testes `node:test` dos workspaces / integração celular ↔ PC.                                                |
| `npm run build`                         | Gera shared, api, pc-agent e mobile.                                                                        |
| `npm run format:check`                  | Prettier (`.prettierrc`). **Informativo**: ainda há arquivos fora do padrão.                                |
| `npm run ci`                            | Tudo acima na ordem do CI: build:shared → lint → typecheck → test → test:integration → build.               |

Não rode `prettier --write` nem `eslint --fix` no repositório inteiro num PR de funcionalidade: a formatação geral será um PR próprio, combinado com o time.

## CI (GitHub Actions)

`.github/workflows/ci.yml` roda em todo `push` e `pull_request`, cancelando execuções antigas da mesma branch/PR:

- **ci** (Linux): `npm ci` + os passos do `npm run ci`; Prettier como passo informativo.
- **windows**: testes do pc-agent e da API em `windows-latest` (o produto é Windows-first).
- **audit**: `npm audit --omit=dev --audit-level=critical`.
- **docker**: `docker build -f apps/api/Dockerfile .` (sem publicar).

## Lint: avisos a corrigir

Regras de bug que ainda falham estão como `warn` em `eslint.config.mjs`; ao zerar uma, promova-a para `error`.

- `no-misused-promises`: `apps/api/src/services/spoolCleanup.ts:53,54`, `apps/mobile/src/app/core/session.service.ts:40`, `apps/mobile/src/app/features/escolher/escolher.component.ts:84`, `apps/pc-agent/src/core/realtime.ts:157`.
- `no-unused-vars`: `apps/mobile/src/app/core/logic/uploader.ts:91` (`catch (e)` sem uso; use `catch {` ou `_e`).
- `no-useless-assignment`: `apps/mobile/src/app/core/logic/chunks.test.ts:12`, `apps/pc-agent/src/core/realtime.ts:163`.
- `no-base-to-string`: `apps/api/src/mail/stalwart.ts:51`, `apps/api/src/ws/hub.ts:156`, `apps/pc-agent/src/main/adapters.ts:58`, `apps/pc-agent/src/renderer/app.ts:23` e 3 em testes.

## Commits

- Mensagens em português, no imperativo, primeira linha com até ~72 caracteres (`Adiciona healthcheck do Mongo no compose`).
- Prefixo de escopo opcional: `api:`, `pc:`, `mobile:`, `shared:`, `infra:`, `docs:`.
- Um assunto por commit; corpo explicando o **porquê** quando não for óbvio.
- Mudança de lockfile só junto da mudança de `package.json` que a causou.

## Branches e PRs

- `main` é protegida: nada de push direto nem force-push.
- Todo trabalho em branch própria (`feat/...`, `fix/...`, `infra/...`, `docs/...`) a partir da `main` atualizada.
- Merge só por PR, com **CI verde** (jobs `ci`, `windows`, `audit` e `docker`) e ao menos uma revisão.
- Prefira PRs pequenos; rebase na `main` antes do merge se o CI estiver desatualizado.

## npm 11 e scripts de instalação

O npm 11 não roda scripts de `postinstall` de pacotes que não estejam liberados. Sem isso, o Electron fica sem o binário: a pasta `node_modules/electron/dist` não aparece e o `npm run dev:pc` falha. Depois do `npm install`, se `node_modules/electron/path.txt` não existir, rode:

```bash
node node_modules/electron/install.js
```

No CI (Node 22 / npm 10) os scripts rodam normalmente.
