# Arkivo — Contrato entre as partes (fonte da verdade)

> **Versionamento: 2026-11-03.** Protocolo `1`, cabeçalhos `X-Arkivo-Client`/`X-Arkivo-Protocol`, `426 UPGRADE_REQUIRED`, fechamento `4426` do WebSocket e `protocol` no `/v1/ping` (§9).
>
> **Integridade da API: 2026-11-04.** (marcado com **[2026-11-04]** no texto) Local `pc` só vale como conferido se o PC **ainda está pareado**; revogar um PC tira os locais dele dos arquivos e avisa os celulares com o evento novo `files.unverified` (§4 Dispositivos, §4 Arquivos, §5, §7.1). Relay com cota global, checagem de disco e reserva atômica; os três casos respondem `507 QUOTA_EXCEEDED` com `error.reason` (§4 Relay, §8). Spool sem cifra: volume cifrado obrigatório em produção (§4 Relay).
>
> **Conta: 2026-11-04.** (marcado com **[2026-11-04]** em §3.1, §4 Saúde, §4 Auth e §8) Confirmação de e-mail (`User.emailVerified`), "esqueci a senha", "sair de todos os dispositivos", exclusão de conta **com senha**, exportação de dados com link de download, aceite dos Termos no cadastro e `GET /v1/legal`. E-mails transacionais enviados pela API (`MAIL_TRANSPORT`, `RESEND_API_KEY`, `MAIL_FROM`, `APP_PUBLIC_URL`). O protocolo continua `1`: a única mudança incompatível (`DELETE /v1/me` passa a exigir `password`) só afeta a exclusão de conta em apps antigos, que recebem `400` e não apagam nada.
>
> **Pastas liberadas: 2026-11-04.** (seção nova **§10**, marcada **[2026-11-04]**) O celular acessa pastas escolhidas no PC: rotas `/v1/fs/*` na LAN com assinatura própria (§10.5), RPC cifrado de ponta a ponta pela API (`POST /v1/fs-rpc/:pcDeviceId`, `fs.request`/`fs.response`, §10.6) e blobs cifrados no spool (`/v1/fs-blobs`, §10.7). Capacidades `fs`/`fs-rpc` em `/v1/ping`, `Device`, `pc.status`, `device.status` e `/v1/health`. O protocolo continua `1` (só há rotas, eventos e campos opcionais novos, §10.9).
>
> **Enviar para o celular: 2026-11-04.** (seção nova **§11**, marcada **[2026-11-04]**) O PC oferece arquivos a um celular: caixa de saída persistente no PC, operações `outboxList`, `outboxDownload`, `outboxDone` e `outboxDecline` nas duas vias do §10, evento `outboxChanged` e capacidade `fs-push` (PC e celular). Nenhuma rota nova na API: `POST /v1/devices/phone` ganha `capabilities`, que chega ao PC em `GET /v1/devices/pc/peers` e `peers.changed`. O protocolo continua `1`.
>
> **Revisão de integração: 2026-11-03.** Unificadas as regras de retomada do envio em pedaços (§4.1), a regra de falha do relay (§4 Relay), os códigos de fechamento do WebSocket (§5), o texto canônico da assinatura LAN (§3.3), CORS (§6 e §8) e o `email` em `pairing.claimed`. Prova de integração celular ↔ PC: `tests/integration/`.

Este documento define como **app do celular** (`apps/mobile`), **API** (`apps/api`) e **receptor do PC** (`apps/pc-agent`) conversam. Tipos TypeScript equivalentes ficam em `packages/shared/src/index.ts`. Nenhuma parte inventa rota, campo ou evento fora daqui; se precisar, atualiza este arquivo e os tipos.

Idioma da interface: português do Brasil. Código, nomes de variáveis e rotas: inglês.

## 1. Visão geral

```
Celular (Angular+Capacitor) ──HTTPS──► API (Node/Express + MongoDB) ◄──WSS── PC (Electron)
        │                                    ▲  spool (fila temporária)
        └────── LAN HTTP direto (porta 47800, assinatura HMAC) ──────►  PC
```

- **Modo direto (mesma rede):** o celular envia o arquivo direto para o servidor HTTP local do PC.
- **Modo relay (fora de casa ou PC sem acesso direto):** o celular envia para a API, que guarda no *spool* (fila temporária em disco). O PC é avisado por WebSocket, baixa da API, confere o hash e confirma. A API então apaga do spool.
- **PC desligado:** se o celular estiver em modo relay, o arquivo espera no spool até o PC ligar. Se o celular estiver na fila local (Wi-Fi only etc.), espera no celular.
- **Verdade sobre "salvo":** um arquivo só conta como salvo quando o PC calcula o SHA-256 do arquivo gravado, ele bate com o hash declarado e o PC reporta à API (`POST /v1/files/:id/locations`). Só arquivos com local verificado podem ser apagados do celular.

## 2. Convenções

- Base da API: `/v1`. JSON em `camelCase`. Datas em ISO 8601 (UTC).
- Erros: HTTP status + corpo `{ "error": { "code": "STRING_CODE", "message": "texto pt-BR" } }`.
- Códigos: `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `GONE` 410 (pareamento expirado), `PAYLOAD_TOO_LARGE` 413, `UPGRADE_REQUIRED` 426 (versão do app ou protocolo recusado, §9), `QUOTA_EXCEEDED` 429/507, `INTERNAL` 500.
- Todo cliente manda `X-Arkivo-Client` e `X-Arkivo-Protocol` (§9).
  - Exceções de status com código `CONFLICT` no envio em pedaços (§4.1): `416` (buraco no `Content-Range`) e `423` (o mesmo arquivo já está sendo recebido por outra conexão). `409` no envio significa **sempre** "hash diferente".
  - Excesso de tentativas (rate limit) → `429` com código `QUOTA_EXCEEDED`.
- Hash: SHA-256 em hex minúsculo (64 caracteres) do conteúdo bruto do arquivo.
- Tipos de arquivo (`FileKind`): `photo` | `video` | `document`.
- IDs: ObjectId do MongoDB em string.

## 3. Autenticação

### 3.1 Usuário (celular)
- Access token JWT (HS256, 15 min) no header `Authorization: Bearer <token>`. Payload: `{ sub: userId, typ: "user" }`.
- Refresh token opaco (64 bytes aleatórios, base64url), guardado com hash SHA-256 no Mongo, validade 30 dias, rotação a cada uso.
- **[2026-11-04]** "Sair de todos" (`POST /v1/auth/logout-all`) e a troca de senha (`POST /v1/auth/reset-password`) apagam todos os refresh tokens da conta **e** invalidam os access tokens já emitidos (a API guarda `sessionsRevokedAt` e recusa token com `iat` anterior, com resolução de 1 s). As conexões WebSocket de celular da conta são fechadas com `4401`. Os PCs (`deviceToken`) não são afetados. Access token de conta apagada também deixa de valer (`401`).

### 3.2 Dispositivo PC
- Ao concluir o pareamento o PC recebe `deviceToken` opaco (base64url, 48 bytes). A API guarda só o hash SHA-256.
- Header: `Authorization: Device <deviceToken>`.

### 3.3 Celular → PC na LAN (modo direto)
- No pareamento, a API gera `pairKey` (32 bytes aleatórios, base64) e entrega ao celular e ao PC. A API guarda `pairKey` cifrado (AES-256-GCM com `PAIRKEY_ENC_KEY`), porque precisa reentregar ao celular após novo login.
- Cada requisição direta leva:
  - `X-Arkivo-Device: <phoneDeviceId>`
  - `X-Arkivo-Ts: <unix ms>` (rejeitar se diferir mais de 120 s do relógio do PC)
  - `X-Arkivo-Sig: base64(HMAC-SHA256(pairKey, METHOD + "\n" + PATH + "\n" + TS + "\n" + SHA256_HEX_DO_ARQUIVO_OU_VAZIO))`
- Texto canônico, byte a byte (função `lanSignaturePayload` em `packages/shared`; mesma implementação no celular e no PC):
  - `METHOD`: método em maiúsculas (`HEAD`, `PUT`).
  - `PATH`: só o caminho, exatamente como vai na linha da requisição (com o percent-encoding aplicado pelo cliente), **sem** host e **sem** query. Ex.: `/v1/files/6650f0c1a2b3c4d5e6f70809`.
  - `TS`: a mesma string enviada em `X-Arkivo-Ts` (inteiro decimal, sem espaços).
  - Último campo: o valor de `X-Arkivo-Hash` (hex minúsculo, 64 caracteres) quando a requisição o envia (`PUT`); vazio quando não envia (`HEAD`). O texto termina no hash, sem `\n` final. Codificação UTF-8.
  - Chave: os 32 bytes obtidos decodificando `pairKey` (base64 padrão com `=`; quem lê também aceita base64url).
  - `X-Arkivo-Sig`: base64 padrão, com `=`, dos 32 bytes do HMAC. O PC compara os bytes decodificados em tempo constante.
- `GET /v1/ping` vai sem assinatura.
- O PC só aceita requisições de celulares que pertençam ao mesmo usuário (a lista vem da API em `GET /v1/devices/pc/peers` e do WS `peers.changed`; o PC guarda a última lista para o modo direto funcionar sem internet). Assinatura inválida → `401`; assinatura válida de celular fora da lista → `403`.

## 4. Rotas da API

### Saúde
- `GET /v1/health` → `HealthResponse = { ok: true, version, protocol, minProtocol, minClientVersions: { pc, mobile } }` (§9)
- **[2026-11-04]** `GET /v1/legal` → `LegalInfo = { termsVersion, privacyVersion, termsUrl, privacyUrl }`: versões atuais dos documentos de `docs/legal/` (`TERMS_VERSION`/`PRIVACY_VERSION`, padrão `0.1`) e os links `<APP_PUBLIC_URL>/termos` e `<APP_PUBLIC_URL>/privacidade`. Sem autenticação.

### Auth
- `POST /v1/auth/register` `{ name, email, password, handle?, termsVersion?, privacyVersion? }` → `201 AuthResponse`
  - **[2026-11-04]** Grava o aceite dos Termos e da Política no `User`: `termsVersion`, `privacyVersion` (as atuais da API) e `termsAcceptedAt`. O celular manda as versões que mostrou (de `GET /v1/legal`); se forem diferentes das atuais → `409 CONFLICT` ("os Termos foram atualizados"). Sem os campos (apps antigos), grava as versões atuais.
  - **[2026-11-04]** Envia, em segundo plano, o e-mail de confirmação com o link `<APP_PUBLIC_URL>/verificar-email?token=<token>` (24 h). Falha no envio não impede o cadastro.
  - `handle` é o nome do futuro e-mail `handle@arkivo.com` (a-z, 0-9, ponto; 3–30). Se ausente, deriva do nome (sem acento, minúsculo, só a-z0-9). Se ocupado, acrescenta número.
  - Senha mínimo 8 caracteres. Hash com bcrypt (custo 12).
- `POST /v1/auth/login` `{ email, password }` → `AuthResponse`
- `POST /v1/auth/refresh` `{ refreshToken }` → `AuthResponse`
- `POST /v1/auth/logout` `{ refreshToken }` → `204`
- `GET /v1/me` → `User`
- `PATCH /v1/me` `{ name? }` → `User`
- `DELETE /v1/me` **[2026-11-04]** `{ password }` → `204` (apaga conta, dispositivos, metadados, spool, links de e-mail pendentes e exportações; desativa caixa de e-mail se houver; PCs recebem WS `device.revoked`)
  - Sem `password` → `400`. Senha errada → `403 FORBIDDEN` ("Senha incorreta. A conta não foi excluída.") e nada é apagado; é `403`, e não `401`, para o celular não tentar renovar o token. Limite: 5 tentativas a cada 15 min por conta (→ `429`).
- `POST /v1/me/export` **[2026-11-04]** → `202 DataExportResponse = { message, downloadUrl, expiresAt }`
  - Gera na hora um JSON (`DataExportFile`, LGPD art. 18) com perfil (inclui o aceite dos Termos), dispositivos, metadados dos arquivos (**não** o conteúdo, que está no PC), sessões abertas (sem tokens) e a trilha de auditoria da conta. Fica em `EXPORT_DIR` por **24 h**.
  - `downloadUrl` = `<PUBLIC_URL>/v1/me/export/<token>` (32 bytes base64url; a API guarda só o SHA-256). O mesmo link vai por e-mail; se o e-mail falhar, a `message` avisa e o link da resposta continua valendo.
  - No máximo **1 por hora** por conta → `429 QUOTA_EXCEEDED` (o link anterior continua valendo).
  - Um job de hora em hora apaga do disco as exportações vencidas; a exclusão da conta apaga as dela na hora.
- `GET /v1/me/export/:token` **[2026-11-04]** (sem autenticação: o token do link é a credencial) → `200` `application/json` com `Content-Disposition: attachment; filename="arkivo-meus-dados-AAAA-MM-DD.json"` e `Cache-Control: no-store`. Pode baixar várias vezes dentro da validade. Token desconhecido → `404`; vencido ou já apagado → `410 GONE`. Limite: 30 por 15 min por IP. O token não aparece nos logs da API.

**[2026-11-04] Confirmação de e-mail, senha e sessões.** Os tokens dos links têm 32 bytes base64url, são de uso único e a API guarda só o SHA-256; pedir um link novo invalida os anteriores do mesmo tipo.
- `POST /v1/auth/verify-email` `{ token }` → `204`; marca `emailVerified: true`. Link inexistente → `400`; vencido (24 h) ou já usado → `410 GONE`. Sem autenticação (abre pelo link). Limite: 20 por 15 min por IP.
- `POST /v1/auth/resend-verification` (usuário) → `204` (novo link de 24 h). Já confirmado → `409`. Limite: 3 por hora por conta. Falha no envio → `500` com mensagem.
- `POST /v1/auth/forgot-password` `{ email }` → **sempre `204`**, na hora, exista ou não a conta (o envio acontece depois, em segundo plano, para nem o tempo de resposta revelar nada). Se a conta existe, manda `<APP_PUBLIC_URL>/redefinir?token=<token>` (vale **1 h**). Limites: 10 por 15 min por IP e 3 por hora por e-mail (→ `429`, igual para conta que existe ou não).
- `POST /v1/auth/reset-password` `{ token, password }` → `204`. Senha mínima 8. Troca a senha, encerra **todas** as sessões do celular (§3.1), invalida os outros links de troca, marca o e-mail como confirmado (o link chegou nele), registra `auth.password_reset` na auditoria e manda o aviso "sua senha foi trocada". Link inexistente → `400`; vencido ou já usado → `410 GONE`. Limite: 10 por 15 min por IP. Depois disso o celular entra de novo com `POST /auth/login`.
- `POST /v1/auth/logout-all` (usuário) → `204`. Encerra as sessões de todos os celulares, inclusive a de quem chamou (§3.1). Os PCs continuam pareados.
- O app **não bloqueia** nada por e-mail não confirmado: só mostra o aviso "Confirme seu e-mail" com "Reenviar".
- Telas do celular que os links abrem: `/redefinir?token=` e `/verificar-email?token=` (hoje no navegador, em `APP_PUBLIC_URL`; App Links/Universal Links e `arkivo://redefinir?token=` ficam para quando houver domínio).

`AuthResponse = { user: User, accessToken, refreshToken, accessTokenExpiresAt }`

`User = { id, name, email, handle, mailAddress (handle@MAIL_DOMAIN), mailEnabled: boolean, emailVerified: boolean, plan: "free" | "lifetime", createdAt }` (**[2026-11-04]** `emailVerified`; um `User` salvo por app antigo pode não ter o campo: tratar `undefined` como "não sei")

### Dispositivos
- `POST /v1/devices/phone` (usuário) `{ name, platform: "android"|"ios"|"web", model?, installId?, capabilities? }` → `201 Device` quando cria, `200 Device` quando o `installId` já existia (atualiza nome/modelo). Um celular novo dispara `peers.changed` para os PCs.
  - **[2026-11-04]** `capabilities`: recursos deste celular (§11). Sem o campo (app antigo), o que estiver gravado continua. Nome ou capacidades diferentes também disparam `peers.changed`, para o PC saber na hora que o app foi atualizado.
- `GET /v1/devices` (usuário) → `Device[]`
- `DELETE /v1/devices/:id` (usuário) → `204`. Se for PC: invalida `deviceToken`, envia WS `device.revoked` ao PC e `pairing.revoked` aos celulares.
  - **[2026-11-04]** Revogar um PC (aqui ou por `POST /devices/pc/logout`) também falha as transferências ativas para ele (devolvendo a cota do spool) e **tira os locais daquele PC de todos os arquivos**: eles saem de `FileRecord.locations` (a API guarda só como histórico interno, `revokedLocations`, com `revokedAt`), o `status` é recalculado (volta a `pending` se não houver outro PC pareado com o arquivo conferido) e o `updatedAt` muda, para `GET /files?updatedSince=` trazer o arquivo de novo. Os celulares recebem `files.unverified { pcDeviceId, fileIds }` (§5), em lotes de até 500 ids. Um PC pareado de novo é um dispositivo novo (outro `id`): os arquivos só voltam a "conferido" quando ele reportar o local de novo.
- `GET /v1/devices/pc/self` (PC) → `Device`
- `PATCH /v1/devices/pc/self` (PC) `{ lanAddresses?: string[], lanPort?: number, freeBytes?: number, folderLabel?: string, appVersion? }` → `Device`
- `GET /v1/devices/pc/peers` (PC) → `{ phones: { id, name, capabilities? }[] }` (todos os celulares da conta, por ordem de criação; **[2026-11-04]** `capabilities`, §11)
- `POST /v1/devices/pc/logout` (PC) → `204` (o PC sai da conta; mesmo efeito de DELETE pelo usuário)

`Device = { id, type: "phone"|"pc", name, platform, online: boolean, lastSeenAt, lanAddresses: string[], lanPort: number|null, freeBytes: number|null, folderLabel: string|null, createdAt }`

### Pareamento por QR
1. PC: `POST /v1/pairings` (sem auth) `{ pcName, platform: "windows"|"macos"|"linux" }` → `201 { pairingId, code, pollToken, expiresAt, qrPayload }`
   - `code`: 8 caracteres base32 (sem 0/O/1/I). Validade 300 s. Guardar só hash de `code` e `pollToken`.
   - `qrPayload` = `arkivo://pair?id=<pairingId>&code=<code>&v=1`
   - O PC mostra, abaixo do QR, o mesmo `qrPayload` como texto com o botão **"Copiar código"**, para quem não consegue escanear. O celular aceita colar esse link (ou `<pairingId> <code>`) em "Digitar código".
2. Celular escaneia e chama `POST /v1/pairings/:pairingId/claim` (usuário) `{ code, phoneDeviceId }` → `PairingClaimResult = { pc: Device, pairKey }`
   - Erros: `GONE` se expirado, `CONFLICT` se já usado, `FORBIDDEN` se code errado (máx 5 tentativas → expira e a API manda `pairing.expired`), `FORBIDDEN` se `phoneDeviceId` não é um celular da conta, `NOT_FOUND` se o pareamento não existe.
   - Cria o `Device` do PC no usuário e o `pairKey`. Um usuário pode ter vários PCs, mas o MVP mostra o principal (mais recente).
3. PC espera o resultado por WebSocket anônimo (`/v1/ws?pairing=<pairingId>&pollToken=<pollToken>`, evento `pairing.claimed`) **ou** por polling `GET /v1/pairings/:pairingId?pollToken=...` a cada 2 s → `{ status: "pending"|"claimed"|"expired", deviceId?, deviceToken?, pairKey?, user?: { name, handle, email } }`. O `deviceToken` é entregue **uma única vez** (para quem retirar primeiro: WS ou polling); depois disso o status fica `claimed` sem segredo e o PC gera um novo QR. O PC usa o WS e só faz polling se o WS não abrir ou cair. `pollToken` errado ou pareamento já apagado (30 min após concluir/expirar) → `404`.
   - `user.email` é o e-mail da conta; o PC mostra "Conectado como <email>".
- `GET /v1/pairings/pc-key/:pcDeviceId` (usuário) → `{ pairKey }` (para o celular recuperar após novo login).

### Arquivos (metadados — o conteúdo nunca vai para o Mongo)
- `POST /v1/files` (usuário) `{ hash, name, kind, size, mimeType, takenAt, sourceDeviceId }` → `201 FileRecord` ou `200 FileRecord` existente (dedupe por `userId+hash`; garante um local `phone` para `sourceDeviceId`). Se o existente já tem local `pc` verificado, o celular marca como salvo sem enviar.
- `GET /v1/files?kind=&cursor=&limit=&updatedSince=` (usuário) → `{ items: FileRecord[], nextCursor }` (ordenado por `takenAt` desc)
- `GET /v1/files/:id` (usuário) → `FileRecord`
- `POST /v1/files/:id/locations` (PC) `{ relativePath, verifiedHash }` → `FileRecord`
  - Se `verifiedHash !== hash` → `409 CONFLICT` e a transferência ativa para esse PC (se houver) vira `failed`.
  - Emite WS `file.verified` para os celulares do usuário.
  - Modo direto: o PC chama esta rota depois de gravar e conferir o arquivo vindo da LAN. Sem internet, guarda o relatório numa fila persistente e reenvia ao reconectar; erros `4xx` (exceto `429`) descartam o relatório.
  - **[2026-11-04]** Se o PC for revogado no meio desta chamada e a gravação acontecer depois da limpeza, a API desfaz o local e responde `401`.
- `POST /v1/files/:id/phone-removed` (usuário) `{ phoneDeviceId }` → `FileRecord` (só aceita se houver ao menos 1 local `pc` verificado **de um PC atualmente pareado à conta** **[2026-11-04]**; senão `409`)
- **[2026-11-04] "Conferido" = local `pc` com `verifiedAt` de um PC atualmente pareado** (o `Device` existe e não foi revogado). Vale para tudo o que responde "já está salvo": `GET /files`, `GET /files/:id`, o dedupe do `POST /files`, `phone-removed`, `stats` e `file.verified`. Local de PC que saiu da conta não aparece em `locations` e não conta para `status`. Dados anteriores a esta regra (PCs revogados antes dela) são migrados na partida da API.
- `GET /v1/files/stats` (usuário) → `{ totalCount, totalBytes, verifiedCount, verifiedBytes, onPhoneVerifiedBytes, byMonth: { month: "YYYY-MM", count }[] }`

`FileRecord = { id, hash, name, kind, size, mimeType, takenAt, createdAt, updatedAt, locations: FileLocation[], onPhone: boolean, status: "pending"|"verified" }`

`FileLocation = { deviceId, type: "phone"|"pc", relativePath: string|null, verifiedAt: string|null }`

Organização no PC: `<pasta escolhida>/<AAAA>/<MM>/<nome>` usando `takenAt` (fuso local do PC). Se já existe um arquivo com o mesmo nome e hash diferente, acrescentar ` (2)`, ` (3)`... antes da extensão. Mesmo nome e mesmo hash = já salvo (idempotente).

### 4.1 Envio em pedaços com retomada (regras comuns ao relay e à LAN)

Valem igualmente para `PUT /v1/relay/:fileId/content` (API) e `PUT /v1/files/:fileId` (PC, §6). Constantes em `packages/shared` (`UPLOAD_STATUS`, `chunkStartDecision`).

- O celular envia em pedaços de 8 MiB. Todo `PUT` parcial leva `Content-Range: bytes <start>-<end>/<total>` (end inclusivo), inclusive o primeiro. Um arquivo que cabe num pedaço vai num `PUT` sem `Content-Range` (corpo = arquivo inteiro a partir do byte 0). `Content-Length` é obrigatório e deve bater com o intervalo.
- `X-Arkivo-Hash` (SHA-256 do arquivo inteiro) vai em **todo** `PUT`.
- `HEAD` → `200` com `X-Arkivo-Received: <bytes>` (0 se nada). `X-Arkivo-Received == total` **não** significa concluído: só a resposta final do último pedaço confirma.
- Decisão pelo `start` do `Content-Range` comparado com o que o servidor tem (`received`):

| Situação | Resposta |
|---|---|
| `start > received` (buraco) | `416` + `X-Arkivo-Received: <received>`; o celular continua desse ponto (no máximo 3 vezes seguidas; sem o cabeçalho, refaz o `HEAD`) |
| `start == received` | grava |
| `start < received` (pedaço reenviado) | trunca em `start` e regrava |
| pedaço intermediário gravado | `202` + `X-Arkivo-Received: <novo total recebido>` |
| último pedaço, hash confere | `200` (relay: `Transfer`; LAN: `{ relativePath, verifiedHash }`) |
| último pedaço, hash diferente | `409` + `X-Arkivo-Received: 0`; o servidor apaga o que tinha |
| o mesmo arquivo já está sendo recebido em outra conexão | `423` (código `CONFLICT`); o celular espera alguns segundos e tenta de novo (não conta como falha) |
| corpo menor que o anunciado | `400` + `X-Arkivo-Received` |

- Retomada no celular: `HEAD` → se `received < total`, continua de `received`; se `received == total`, reenvia o **último pedaço** (`start < received`) para o servidor concluir; se já estava concluído, a resposta é idempotente (`200`).
- `409` no envio sempre significa hash diferente: o celular recalcula o hash, registra de novo (`POST /files`) e reenvia.

### Relay (spool / fila temporária)
- `PUT /v1/relay/:fileId/content?targetDeviceId=<pcId>` (usuário) corpo binário `application/octet-stream`, headers `Content-Length`, `X-Arkivo-Hash` e `Content-Range` (§4.1).
  - `HEAD /v1/relay/:fileId/content` → `X-Arkivo-Received` (0 se não há envio ativo; restos órfãos no disco são ignorados).
  - `targetDeviceId` obrigatório no primeiro pedaço (`start = 0`); nos demais é opcional (o celular manda em todos, inclusive no `HEAD`). PC que não é da conta → `403`.
  - `X-Arkivo-Hash` diferente do `hash` registrado no `POST /files` → `409` antes de gravar.
  - Respostas conforme §4.1, com corpo `Transfer` nos `2xx`. Último pedaço com hash certo → `Transfer {status: "ready"}`, WS `transfer.ready` para o PC alvo e `transfer.updated` para os celulares. Hash errado → `409`, a transferência vira `failed`.
  - `PUT` depois que o arquivo já está pronto (`ready`/`downloading`) → `200` idempotente, sem gravar.
  - Limites: `RELAY_MAX_FILE_BYTES` (padrão 2 GiB) → `413 PAYLOAD_TOO_LARGE`; `RELAY_USER_QUOTA_BYTES` (padrão 5 GiB por usuário no spool, reservando o tamanho total no primeiro pedaço; contam `uploading`, `ready` e `downloading`) → `507 QUOTA_EXCEEDED`.
  - **[2026-11-04]** Também → `507 QUOTA_EXCEEDED`: `RELAY_GLOBAL_QUOTA_BYTES` (padrão 100 GiB, soma de todas as contas) e `RELAY_MIN_FREE_DISK_BYTES` (padrão 10 GiB que precisam sobrar livres no volume do spool depois de gravar o que falta do arquivo; conferido em **todo** pedaço com `statfs`). O corpo leva `error.reason`: `"user"` (cota da conta), `"global"` ou `"disk"` (o servidor está cheio; não é culpa do usuário). O celular continua tratando todo `507` do relay como "fila temporária cheia" e tenta mais tarde; o `reason` é opcional para mensagens melhores.
  - **[2026-11-04]** A reserva é atômica (contadores no Mongo com `$inc` condicional, por usuário e global): dois primeiros pedaços simultâneos não passam juntos pela cota. A reserva é devolvida quando a transferência vira `done`, `failed` ou `expired`, quando o PC é revogado e quando a conta é apagada.
  - **[2026-11-04] Cifra:** o spool guarda o conteúdo **sem cifra**. Em produção o `SPOOL_DIR` **precisa** estar num volume cifrado (LUKS, BitLocker, EBS/disco gerenciado cifrado etc.). Cifra de ponta a ponta celular → PC fica para depois (TODO `cifra-e2e` em `apps/api/src/services/spool.ts`).
- `GET /v1/relay/pending` (PC) → `Transfer[]` com status `ready` **ou `downloading`** para este PC (o PC chama ao conectar; `downloading` cobre o PC que reiniciou no meio de um download).
- `GET /v1/relay/:transferId/download` (PC) → stream do conteúdo, suporta `Range: bytes=<offset>-` (`206` com `Content-Range`; `416` se inválido). O primeiro download muda o status para `downloading`. Transferência fora de `ready`/`downloading` → `410 GONE`.
- `POST /v1/relay/:transferId/ack` (PC) `{ relativePath, verifiedHash }` → `204`. Faz o mesmo que `POST /files/:id/locations`, marca `Transfer.done` e apaga do spool. Repetido depois de `done` → `204`. Em `failed`/`expired` também registra o local se o hash bater (o arquivo está no disco do PC); hash diferente → `409`.
- `POST /v1/relay/:transferId/fail` (PC) `{ reason }` → `204`. **Terminal:** a API marca `failed`, apaga o spool e emite `transfer.updated` aos celulares.
- **Regra de falha do relay (única para as três partes):**
  - Falha transitória no PC (rede, `5xx`/`429`, pouco espaço livre, erro de disco, download interrompido) → o PC **não** chama `fail`; tenta de novo com backoff (retomando com `Range`). O conteúdo continua no spool; se o PC desistir localmente, o item volta pelo `GET /relay/pending` na próxima conexão.
  - SHA-256 do arquivo baixado diferente: na 1ª vez o PC apaga o `.part` e baixa de novo do zero, sem `fail`; na 2ª vez chama `fail` (uma vez) e desiste. Transferência sem metadados do arquivo → `fail`.
  - Respostas `404`/`410`/`409`/`401`/`403` da API → o PC desiste sem `fail` (a API já encerrou a transferência).
  - O PC **nunca** tenta de novo uma transferência depois de chamar `fail`.
  - O celular, ao receber `transfer.updated` com `failed` ou `expired`, devolve o arquivo à fila e o reenvia (novo `PUT` do byte 0, com o mesmo `fileId`; se outra transferência daquele arquivo já está sendo enviada, ignora o aviso).
- Revogar o PC (`DELETE /devices/:id` ou `POST /devices/pc/logout`) marca as transferências ativas dele como `failed` e limpa o spool (e invalida os locais dele, ver §4 Dispositivos **[2026-11-04]**).
- Spool expira em `RELAY_TTL_DAYS` (padrão 14): a transferência vira `expired` (com `transfer.updated`). Um job a cada hora limpa expirados.

`Transfer = { id, fileId, file: FileRecord, targetDeviceId, mode: "relay", status: "uploading"|"ready"|"downloading"|"done"|"failed"|"expired", bytesReceived, size, createdAt, updatedAt }`

### E-mail (Fase 2 — atrás de feature flag)
- `GET /v1/mail/handle-available?handle=` → `{ available, suggestion }` (sempre disponível, mesmo com flag desligada, para o cadastro reservar o nome)
- `GET /v1/mail/status` (usuário) → `{ enabled, address, provider: "stalwart"|"disabled" }`
- Com `MAIL_ENABLED=true`, o cadastro cria a caixa no Stalwart via API de gerenciamento; com `false`, só reserva o `handle`. O app mostra "Em breve" quando `mailEnabled` é falso (como no design).

## 5. WebSocket `/v1/ws`

- Conexão autenticada por query: `?token=<accessToken>` (celular) ou `?device=<deviceToken>` (PC), ou anônima de pareamento `?pairing=<id>&pollToken=<t>`.
- Versão do cliente: cabeçalhos `X-Arkivo-Client`/`X-Arkivo-Protocol` no upgrade **ou** a query `&client=<kind>/<semver>&protocol=<n>` (o navegador não deixa mandar cabeçalho no WebSocket; o cabeçalho tem prioridade). Regras no §9.4.
- Mensagens JSON `{ "type": string, "data": object }`.
- Ping/pong: **frames de controle do protocolo WebSocket** (não JSON) a cada 25 s; navegadores/WebView e a lib `ws` respondem sozinhos. Qualquer mensagem recebida também conta como sinal de vida. A API derruba a conexão após 60 s sem pong (o PC passa a `online=false`). A API nunca manda `{type:"ping"}` em JSON.
- Códigos de fechamento (`WS_CLOSE` em `packages/shared`):
  - `4401` — credencial ausente, inválida ou expirada (a API aceita o upgrade e fecha logo em seguida, para o cliente ver o código; um `401` no upgrade chegaria ao navegador só como `1006`). Celular: renova o access token e reconecta. PC: consulta `GET /devices/pc/self` antes de reconectar; `401` lá = PC removido.
  - `4001` — PC removido da conta ou conta apagada. O PC trata como `4401` (confere `pc/self`).
  - `4426` — versão do app abaixo do mínimo ou protocolo incompatível (equivale ao HTTP `426`, §9). O `reason` é o JSON `{ minVersion, kind, protocol }`. O cliente **não reconecta** e mostra a tela de atualização.
  - `4400` — `client`/`protocol` malformado (erro de programação). O cliente registra e segue o backoff normal.
  - `1000` — conexão anônima de pareamento encerrada (expirou/concluiu); `1001` — servidor desligando.
  - Outros códigos: reconectar com backoff exponencial (celular 1 s → 30 s; PC 1 s → 60 s com jitter).
- Ao conectar, o celular recebe um `device.status` por PC da conta. A cada reconexão o celular confere `GET /v1/devices` e `GET /v1/files/:id` dos itens que esperavam confirmação (eventos perdidos).
- **API → PC:** `transfer.ready { transfer }`, `device.revoked { }`, `peers.changed { phones }`
- **API → celular:** `file.verified { file }`, `device.status { deviceId, online, lanAddresses, lanPort, freeBytes }`, `pairing.revoked { pcDeviceId }`, `transfer.updated { transfer }`, **[2026-11-04]** `files.unverified { pcDeviceId, fileIds: string[] }` (o PC saiu da conta; esses arquivos deixaram de estar conferidos por ele; lotes de até `FILES_UNVERIFIED_BATCH` = 500 ids). Ao receber, o celular volta esses itens de "salvo" para pendente/conferência (`GET /files/:id` traz o estado atual) e não os apaga. Celular sem WebSocket na hora fica sabendo pelo `updatedAt` (`GET /files?updatedSince=`) e, de qualquer forma, o "Liberar espaço" consulta `GET /files/:id` antes de apagar.
- **API → pareamento anônimo:** `pairing.claimed { deviceId, deviceToken, pairKey, user: { name, handle, email } }`, `pairing.expired {}`. Se o PC conectar depois do claim e o segredo ainda não foi entregue, recebe `pairing.claimed` na hora.
- **[2026-11-04] Pastas liberadas:** `fs.request`, `fs.response`, `fs.event`, `fs.blob.updated` e o campo opcional `capabilities` em `pc.status`/`device.status`; `maxPayload` do hub sobe para 512 KiB (§10.8).
- **[2026-11-04] Enviar para o celular:** nenhum tipo novo de mensagem. O PC usa o `fs.event` com o conteúdo cifrado `outboxChanged` (§11.5) e o `peers.changed` passa a levar `capabilities` por celular. Ao reconectar, o celular também consulta a caixa de saída, porque o evento pode ter se perdido.
- **PC → API:** `pc.status { lanAddresses, lanPort, freeBytes, receiving: boolean }` ao conectar, a cada 60 s e quando `receiving` muda (a API repassa como `device.status` aos celulares, sem `receiving`). `lanAddresses` = IPv4 privados das interfaces ativas (vazio se o servidor LAN não abriu a porta).

## 6. Servidor local do PC (modo direto)

Porta padrão `47800` (configurável), escuta em `0.0.0.0`, HTTP simples na LAN (a integridade vem do HMAC + SHA-256; o conteúdo não sai da rede local). Todas as rotas exigem as assinaturas do §3.3, exceto `/ping`.

- `GET /v1/ping` → `{ app: "arkivo-pc", deviceId, version, protocol, minProtocol }` (o celular usa para descobrir qual endereço LAN responde, timeout 1,5 s; antes do pareamento `deviceId` é `""`). Sempre `200`, mesmo para celular incompatível: é por ele que o celular descobre o `protocol` do PC (§9.6).
- As demais rotas conferem `X-Arkivo-Protocol` **antes** da assinatura: protocolo fora da faixa do PC → `426 UPGRADE_REQUIRED` (com `minVersion: null`, `kind: "mobile"`); malformado → `400`; ausente → aceita.
- `HEAD /v1/files/:fileId` → header `X-Arkivo-Received` (bytes já recebidos num arquivo `.part`)
- `PUT /v1/files/:fileId` corpo binário, headers `X-Arkivo-Hash`, `X-Arkivo-Name` (URI-encoded), `X-Arkivo-Taken-At`, `X-Arkivo-Kind`, `Content-Range` para retomada. Pedaços de 8 MiB. Respostas conforme §4.1.
  - Ao completar: o PC calcula o SHA-256 do arquivo final, compara, move de `.part` para o destino organizado, chama a API `POST /v1/files/:fileId/locations` e responde `200 { relativePath, verifiedHash }`. Hash diferente → apaga `.part`, `409`. O celular só marca "salvo" se `verifiedHash` for igual ao hash dele; para **apagar do celular** continua valendo a regra 7.1 (local `pc` com `verifiedAt` na API).
  - `PUT` sem `Content-Range` e sem `Content-Length` → `411`.
  - Pouco espaço livre (menos que os bytes que faltam + 1 GiB) → `507`.
  - `503` se a pasta de destino não está configurada.
- `GET /v1/files/:fileId/thumbnail` (opcional no MVP) → `404` se não houver.
- **[2026-11-04]** Rotas `/v1/fs/*` das pastas liberadas, com assinatura própria (nonce, query e corpo assinados) e CORS ampliado: §10.5. O `/v1/ping` ganha `capabilities` (§10.9).
- CORS (para o `fetch` do navegador em desenvolvimento): todas as respostas levam `Access-Control-Allow-Origin: *` e `Access-Control-Expose-Headers: X-Arkivo-Received`; o preflight `OPTIONS` responde `204` com `Access-Control-Allow-Methods: GET, HEAD, PUT, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Content-Range, X-Arkivo-Device, X-Arkivo-Ts, X-Arkivo-Sig, X-Arkivo-Hash, X-Arkivo-Name, X-Arkivo-Taken-At, X-Arkivo-Kind, X-Arkivo-Client, X-Arkivo-Protocol` e, se pedido, `Access-Control-Allow-Private-Network: true`.
- No app nativo, o celular faz as chamadas `http://` da LAN (`/v1/ping`, `HEAD`, `PUT`) pelo HTTP nativo do Capacitor (`CapacitorHttp`), que não passa pelo WebView (`https://localhost` / `capacitor://localhost`) e por isso não sofre bloqueio de conteúdo misto nem depende de CORS. No navegador (`ng serve`) usa `fetch`. O app só fala HTTP com hosts de rede privada.
- Organização: `.part` da LAN usa o `fileId`; o do relay usa `relay-<transferId>`. Nome sanitizado antes da regra de colisão; `relativePath` sempre com `/`; `takenAt` inválido → mês atual do PC.

## 7. Regras de produto que todas as partes respeitam

1. Nunca apagar do celular algo sem local `pc` com `verifiedAt` na API. **[2026-11-04]** O local precisa ser de um PC **atualmente pareado** à conta; a API já tira de `locations` os locais de PCs revogados (§4 Arquivos).
2. Upload só no Wi-Fi por padrão; opção "Só com o celular carregando" desligada por padrão.
3. Ordem de tentativa no celular: direto (se algum `lanAddress` responde `/v1/ping` com o `deviceId` certo **e protocolo compatível**, §9.6) → relay.
4. Se o PC estiver offline e o modo for relay, o arquivo fica no spool; o app mostra "vão assim que ele ligar".
5. Transferência de nuvem → PC nunca começa sozinha (fora do MVP).
6. Textos da interface seguem os do protótipo em `docs/design/`.

## 8. Variáveis de ambiente da API

`PORT=3000`, `MONGO_URI`, `JWT_SECRET`, `PAIRKEY_ENC_KEY` (32 bytes base64), `SPOOL_DIR=./data/spool`, `EXPORT_DIR=./data/exports`, `RELAY_MAX_FILE_BYTES`, `RELAY_USER_QUOTA_BYTES`, `RELAY_GLOBAL_QUOTA_BYTES`, `RELAY_MIN_FREE_DISK_BYTES` (**[2026-11-04]**), `RELAY_TTL_DAYS`, `CORS_ORIGINS`, `MAIL_ENABLED=false`, `MAIL_DOMAIN=arkivo.com`, `STALWART_URL`, `STALWART_ADMIN_USER`, `STALWART_ADMIN_PASSWORD`, `PUBLIC_URL`, `MIN_CLIENT_VERSION_PC=0.1.0`, `MIN_CLIENT_VERSION_MOBILE=0.1.0` (semver, validados no início; §9). **[2026-11-04]** E-mails da conta: `MAIL_TRANSPORT=log|resend` (padrão `log`: só escreve no log), `RESEND_API_KEY` (obrigatória com `resend`), `MAIL_FROM` (padrão `Arkivo <nao-responda@arkivo.com>`), `APP_PUBLIC_URL` (base dos links dos e-mails, padrão `http://localhost:4600`). **[2026-11-04]** Pastas liberadas (§10.7): `FS_BLOB_MAX_BYTES` (padrão = `RELAY_MAX_FILE_BYTES`), `FS_BLOB_TTL_MINUTES` (padrão 60); os blobs usam as mesmas cotas do relay. Documentos legais: `TERMS_VERSION`, `PRIVACY_VERSION` (padrão `0.1`, as constantes do shared). Internas: `NODE_ENV`, `LOG_LEVEL`, `TRUST_PROXY`, `JSON_BODY_LIMIT`.

- `CORS_ORIGINS` padrão: `http://localhost:4600,http://localhost:4200,http://localhost,capacitor://localhost,https://localhost` (WebView Android, WebView iOS e `ng serve`). Requisições sem `Origin` (PC, apps nativos) são sempre aceitas.
- A API libera os cabeçalhos `Authorization, Content-Type, Content-Range, X-Arkivo-Hash, X-Arkivo-Client, X-Arkivo-Protocol` e expõe `X-Arkivo-Received, X-Arkivo-Hash, Content-Range, Accept-Ranges`.

## 9. Versão de protocolo e de cliente

Tipos e helpers em `packages/shared/src/protocol.ts` (`PROTOCOL_VERSION`, `MIN_PROTOCOL_VERSION`, `CLIENT_HEADER_NAMES`, `formatClientHeader`/`parseClientHeader`, `compareSemver`, `checkClientCompat`, `UpgradeRequiredBody`). As três partes usam a mesma função `checkClientCompat`.

### 9.1 Cabeçalhos

| Cabeçalho | Formato | Exemplo |
|---|---|---|
| `X-Arkivo-Client` | `<kind>/<semver>`, `kind` = `pc` ou `mobile`; semver `MAJOR.MINOR.PATCH` com `-pré` e `+build` opcionais | `pc/0.1.0`, `mobile/1.2.0-beta.1` |
| `X-Arkivo-Protocol` | inteiro decimal positivo (`PROTOCOL_VERSION` de quem envia) | `1` |

- O PC manda os dois em toda chamada à API (versão de `app.getVersion()`); o celular manda os dois em toda chamada à API e ao PC na LAN (versão de `environment.appVersion`).
- No WebSocket vão como query `client` e `protocol` (§5).
- Comparação de versões: precedência do semver.org (`1.0.0-beta < 1.0.0`; `+build` ignorado).

### 9.2 Decisão do servidor (API e servidor LAN do PC)

Na ordem:
1. **Sem nenhum dos dois cabeçalhos** → aceita (ferramentas, monitoramento, `curl` no `/v1/health`, builds anteriores a esta seção). A API registra em nível `debug`.
2. **Cabeçalho presente e malformado** → `400 VALIDATION_ERROR` (WS: `4400`).
3. **Protocolo fora da faixa** `[MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]` do servidor → `426 UPGRADE_REQUIRED` (WS: `4426`).
4. **Versão abaixo do mínimo do seu `kind`** (`MIN_CLIENT_VERSION_PC`/`MIN_CLIENT_VERSION_MOBILE` na API; o PC não tem mínimo de celular) → `426 UPGRADE_REQUIRED` (WS: `4426`).
5. Senão → segue para a rota (autenticação depois).

Na API a regra vale para **todas** as rotas de `/v1`, inclusive `/v1/health` e rotas inexistentes, antes da autenticação.

### 9.3 Resposta `426`

```json
{ "error": { "code": "UPGRADE_REQUIRED", "message": "Esta versão não é mais aceita. Atualize o Arkivo para PC para a versão 0.2.0 ou mais nova.",
             "minVersion": "0.2.0", "kind": "pc", "protocol": 1 } }
```

- `minVersion`: mínimo do `kind` do cliente (`null` se o servidor não tem mínimo, como o PC na LAN, ou se o cliente não mandou `X-Arkivo-Client`).
- `kind`: o `kind` do cliente recusado (`null` se não informado).
- `protocol`: `PROTOCOL_VERSION` do servidor.
- Um cliente que recebe `426` sem esse corpo (proxy, versão futura) trata do mesmo jeito, com `minVersion: null`.

### 9.4 WebSocket

A API confere a versão **antes** da credencial. Recusa: aceita o upgrade e fecha logo com `4426` (ou `4400`), como no `4401`, porque um `426` no upgrade chegaria ao navegador só como `1006`. `reason` = `JSON.stringify({ minVersion, kind, protocol })` (cabe nos 123 bytes do frame).

### 9.5 Comportamento dos clientes

- **PC:** qualquer `426` da API ou `4426` no WebSocket (inclusive no pareamento) → estado `updateRequired`: para WebSocket, relay, pareamento e servidor LAN; não tenta de novo; mantém credenciais, pasta e histórico; o renderer mostra "Atualize o Arkivo para PC" com a versão instalada e a mínima. A versão nova retoma ao abrir.
- **Celular:** `426` da API (HTTP ou relay) ou `4426` → tela bloqueante "Atualize o Arkivo" por cima de todas as telas; o backup fica pausado e o WebSocket não reconecta. `426` vindo **do PC na LAN** não bloqueia o app: o envio cai no relay (e a LAN é evitada por 10 min).

### 9.6 Ping e escolha de rota

- `GET /v1/ping` do PC inclui `protocol` e `minProtocol`. Resposta sem `protocol` = protocolo `1` (PC anterior a esta seção).
- O celular só usa a LAN se `protocol` do PC estiver na sua faixa `[MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]` **e** `minProtocol` do PC ≤ o `PROTOCOL_VERSION` do celular. Senão o PC conta como "não respondeu" e o envio vai pelo relay.
- `GET /v1/health` da API devolve `protocol`, `minProtocol` e `minClientVersions` (para diagnóstico e monitoramento; os clientes não dependem dele).

### 9.7 Quando subir o `PROTOCOL_VERSION`

- **Sobe** (inteiro +1) em mudança **incompatível** do contrato: remover ou renomear rota, campo ou evento; mudar o significado ou o tipo de um campo; mudar o texto assinado do HMAC (§3.3), as regras de pedaços (§4.1) ou o formato de erro; tornar obrigatório um campo que era opcional.
- **Não sobe** em mudança compatível: rota, evento ou campo opcional **novos** (quem não conhece ignora), mensagens de texto, novos códigos de erro em situações que antes eram `500`. Para obrigar a atualização sem quebrar o protocolo, basta subir `MIN_CLIENT_VERSION_PC`/`MIN_CLIENT_VERSION_MOBILE` na API.
- **Como subir:** (1) a build nova de cada parte passa a aceitar a faixa `[N-1, N]` (`MIN_PROTOCOL_VERSION = N-1`, `PROTOCOL_VERSION = N`) e fala `N` com quem fala `N`; (2) a API é publicada primeiro; (3) depois PC e celular; (4) quando quase todos atualizaram, a API sobe `MIN_PROTOCOL_VERSION` para `N` (e, se quiser, os `MIN_CLIENT_VERSION_*`), e os clientes antigos recebem `426`.
- Um cliente com protocolo **maior** que o do servidor também recebe `426` (implantação fora de ordem); por isso a API sempre vai antes.
- **[2026-11-04]** Recursos novos e opcionais são anunciados por **capacidades** (`capabilities` no `/v1/ping`, em `Device`, `pc.status`, `device.status` e `/v1/health`; §10.9; o celular anuncia em `POST /v1/devices/phone`, §11.6) em vez de subir o protocolo.
- Toda subida atualiza este §9, o `packages/shared/src/protocol.ts` e a linha "Versionamento" no topo deste arquivo.

## 10. Pastas liberadas (acesso aos arquivos do PC pelo celular) [2026-11-04] (unidade inteira e "Unidades deste PC": [2026-11-06])

Tipos, constantes e helpers em `packages/shared/src/fs.ts` (modelo, validação, bloqueio do sistema, query e texto assinado da LAN, `parseFsRequest`) e `packages/shared/src/e2e.ts` (HKDF, envelope AES-GCM, blobs em pedaços, anti-replay, HMAC via WebCrypto). Rodam no Node, no Electron e no navegador; as três partes **usam essas funções** em vez de reimplementar.

### 10.1 Visão geral e decisões

- No programa do PC o usuário escolhe pastas de qualquer unidade (C:, D:, HD externo, compartilhamento de rede mapeado) para o celular acessar. Cada pasta escolhida é uma **raiz** (`SharedRoot`). O celular pode listar, ver prévia, baixar, enviar, criar pasta, renomear, mover (entre pastas liberadas) e apagar. **Apagar sempre manda para a Lixeira do sistema** (`shell.trashItem` do Electron); o Arkivo nunca apaga em definitivo.
- Há um interruptor geral no PC, **"Acesso pelo celular"** (desligado até o usuário adicionar a primeira pasta). Desligado → toda operação responde `FS_DISABLED`.
- Dois transportes com **as mesmas operações e os mesmos tipos**:
  - **LAN** (mesma rede, preferido): rotas HTTP `/v1/fs/*` no servidor local do PC (§6), assinadas por requisição (§10.5).
  - **Remoto** (fora de casa, ou PC sem LAN): RPC pela API com envelope cifrado de ponta a ponta (§10.6); conteúdo grande vai por blobs cifrados em pedaços no spool (§10.7). A API não vê nomes, listas nem conteúdo (com a ressalva honesta do §10.12).
- O celular escolhe a via como no backup (§7.3): LAN se o ping responde com o `deviceId` certo, protocolo compatível **e** `capabilities` com `"fs"`; senão remoto. O PWA servido por HTTPS não consegue chamar `http://` da LAN (conteúdo misto): usa sempre o remoto.
- Não sobe o `PROTOCOL_VERSION` (§10.9): só há rotas, eventos e campos opcionais novos, anunciados por capacidades.

### 10.2 Modelo, caminhos e bloqueio do sistema

**Raiz (`SharedRoot`)**, guardada só no PC (`config.json`): `{ id, label, absPath, addedAt }`.
- `id`: 16 bytes aleatórios em base64url (22 caracteres; o tipo aceita `FS_ROOT_ID_RE`), gerado ao adicionar e **estável** enquanto a raiz existir. Remover e adicionar de novo gera outro `id` (o celular recebe `ROOT_REMOVED` nos itens antigos).
- `label`: padrão = nome da pasta; para a **unidade inteira** **[2026-11-06]**, o nome do volume com a letra, como no Explorer ("Windows (C:)"), ou pelo tipo: "Disco local (C:)", "Pen drive (E:)", "Unidade de rede (Z:)", "CD/DVD (D:)" (no macOS/Linux, o nome do volume); o usuário pode mudar no PC; até `FS_ROOT_LABEL_MAX` (64) caracteres. Rótulos repetidos são permitidos (vale o `id`).
- No máximo `FS_MAX_ROOTS` (32). Raízes **não podem se sobrepor** (`fsRootsOverlap`): o PC recusa uma pasta dentro de outra já liberada, ou que contenha uma já liberada (assim cada arquivo tem um único `rootId` + caminho). **[2026-11-06]** Exceção de fluxo, não de regra: liberar uma **unidade inteira** do Windows que já contém pastas liberadas oferece **trocar** essas pastas pela unidade, com confirmação; a troca é uma gravação só (as pastas saem, a unidade entra, os envios parciais delas são apagados) e no celular as pastas trocadas respondem `ROOT_REMOVED`. Pasta dentro de uma unidade já liberada inteira → "Esta pasta já está liberada: ela fica em "<rótulo>", a unidade C: inteira."; a mesma unidade de novo → "Esta unidade já está liberada inteira.".
- **O celular vê** `FsRootInfo = { id, label, drive, available, freeBytes, trashAvailable, addedAt }`. O caminho absoluto nunca sai do PC. `drive` é só exibição (`"C:"`, `"E:"`, nome do volume). `available: false` quando a pasta não está acessível agora (HD desconectado): as operações nela respondem `ROOT_UNAVAILABLE`. `trashAvailable: false` em volumes sem Lixeira (§10.11).

**Entrada (`FsEntry`)**: `{ name, type: "file"|"dir", size (null em pasta), mtime (ISO UTC), mime (null em pasta; `fsMimeFromName`), hidden, hasThumb }`.

**Caminhos**: sempre **relativos à raiz**, com `/`, em NFC; `""` é a própria raiz. Regras (`normalizeFsPath`, que também normaliza para NFC):
- sem `/` no começo, sem `C:`, sem `\`, sem segmentos vazios (`a//b`, `a/`), sem `.` nem `..`;
- até `FS_PATH_MAX_BYTES` (1024) bytes UTF-8 e `FS_PATH_MAX_DEPTH` (64) segmentos;
- cada segmento passa por `checkFsName(_, 'reference')`: até `FS_NAME_MAX_BYTES` (255) bytes UTF-8, sem `/ \ :` (o `:` abriria fluxos alternativos do NTFS) nem controles U+0000–U+001F, e sem o prefixo reservado `.arkivo-`.
- Caminho inválido → `FORBIDDEN_PATH`.

**Nomes novos** (`mkdir`, `rename`, `upload`): `checkFsName(_, 'create')`, com as regras do Windows **em qualquer PC** (o arquivo pode ir para qualquer sistema depois): além das de `reference`, sem `< > " | ? *` e DEL, sem ponto ou espaço no fim (o Windows os remove sem avisar), não vazio nem só espaços, e não pode ser nome de dispositivo do Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM0–9`, `LPT0–9`, `COM¹²³`, `LPT¹²³`, `CONIN$`, `CONOUT$`, com ou sem extensão, sem diferenciar maiúsculas). Inválido → `INVALID_NAME` com a mensagem de `FS_NAME_PROBLEM_MESSAGES`.

**Resolução no PC** (obrigatória em toda operação, nas duas vias):
1. `rootId` desconhecido → `ROOT_REMOVED`; raiz inacessível → `ROOT_UNAVAILABLE`.
2. `alvo = path.join(absPath, ...segmentos)`; depois `fs.promises.realpath` do alvo (para criação: do pai) e da raiz.
3. O `realpath` precisa estar **dentro do `realpath` da raiz** (`isAbsPathInside`) e não pode estar bloqueado (`fsBlockedReason`); senão `FORBIDDEN_PATH`. Isso recusa symlink, junction e ponto de montagem que saiam da raiz; links que apontam para dentro da mesma raiz funcionam. `rename`, `move` e `trash` agem **no próprio link** (`lstat`), nunca no destino dele.
4. Nomes vindos do disco vão ao celular em NFC. No Linux, se o `lstat` do caminho em NFC der `ENOENT`, o PC procura no `readdir` do pai um nome equivalente em NFC/NFD.
5. Windows e macOS não diferenciam maiúsculas: comparações de colisão e de "dentro de" usam esse modo; `rename` que só muda maiúsculas (`foto.jpg` → `Foto.jpg`) é permitido.

**Bloqueio do sistema** (`fsBlockedReason`, `fsRootRejectReason`). O PC passa `FsSystemContext` com `os.homedir()`, `%SystemDrive%`, `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`, `%ProgramData%` e, em `extraBlocked`, a pasta de dados do Arkivo (`app.getPath('userData')`). Vale para a escolha da raiz **e** para tudo que for alcançado dentro dela (inclusive por link):
- **Raiz de unidade (decisão, revista em [2026-11-06]):** no Windows **qualquer** unidade pode ser liberada inteira, **inclusive a do sistema** (`C:\`, ou a de `%SystemDrive%`), além de `D:\`, `E:\` do HD externo e `\\nas\fotos`; as pastas do sistema continuam bloqueadas **por dentro**, pela mesma `fsBlockedReason` (lista abaixo), em qualquer nível e também por link. A raiz `/` do macOS e do Linux continua **recusada** (`filesystem-root`, "Escolha uma pasta dentro dele"): esses PCs não estão no beta e liberar `/` exigiria outra lista; `/Volumes/HD`, `/media/...` podem. Antes, `C:\` era recusado (`system-drive-root`, código removido). `isFsDriveRoot(abs, platform)` diz se o caminho é a raiz de uma unidade do Windows (`C:\`, `E:\`; compartilhamento não conta) e `fsDriveLetter` dá a letra.
  - **Aviso ao liberar a unidade inteira:** o PC mostra e pede confirmação: no `C:` "O celular vai ver todo o disco C:, menos as pastas do sistema e de programas." com o que continua bloqueado (Windows, Arquivos de Programas, ProgramData, dados de programas, pastas de outros usuários, chaves e senhas, dados do Arkivo); em outra unidade "O celular vai ver todos os arquivos do disco E:, menos as pastas do sistema que houver nele."; e, se houver, as pastas que vão ser trocadas.
  - **Proteção de pastas (já existia; ampliada):** `rename`, `move` e `trash` recusam (`FORBIDDEN_PATH`) a pasta que **contém** o perfil do usuário, a pasta de dados do Arkivo ou **a pasta do backup** (§4 Organização), e a própria pasta do backup. Com `C:\` inteiro, isso protege `Users`, `Users\<você>` e a pasta do backup; o que está dentro delas continua valendo.
  - **Raiz sem permissão de gravar:** gravar **arquivo** direto em `C:\` costuma exigir administrador (criar pasta não). Antes de receber um envio para a raiz de uma unidade do Windows, o PC cria e apaga um arquivo vazio `.arkivo-teste-*`; negado → `PERMISSION_DENIED` "O Windows não deixa gravar arquivos direto na raiz do disco. Escolha uma pasta dentro dele." (sem gastar banda). Renomear ou mover arquivo para a raiz e criar pasta nela respondem `PERMISSION_DENIED` com texto claro (não o `BUSY` do `EPERM`). Sem permissão para criar a pasta de parciais (`C:\.arkivo-fs-parciais`) → `PERMISSION_DENIED` pedindo para liberar uma pasta dentro do disco. O celular mostra a mensagem do PC em `PERMISSION_DENIED` (como em `INVALID_NAME`).
- **Windows** (sem diferenciar maiúsculas): `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%`; no primeiro nível de **qualquer** unidade: `Windows`, `Program Files`, `Program Files (x86)`, `ProgramData`, `$Recycle.Bin`, `RECYCLER`, `System Volume Information`, `Recovery`, `$WinREAgent`, `Config.Msi`, `$SysReset`, `$Windows.~BT`, `$Windows.~WS`, `Windows.old`, `Boot`, `Documents and Settings`, `MSOCache`, `$GetCurrent`, `OneDriveTemp`, `PerfLogs`, **[2026-11-06]** `Arquivos de Programas`, `Arquivos de Programas (x86)` (junções do Windows em português; o `realpath` já cai em Program Files), `inetpub`, e os arquivos `pagefile.sys`, `hiberfil.sys`, `swapfile.sys`, `DumpStack.log*`, `bootmgr`, `BOOTNXT`, `BOOTSECT.BAK`; `<unidade>\Users\<qualquer>\AppData`, `Users\Default`, `Default User`, `All Users`, `DefaultAppPool`, e `NTUSER.*`/`UsrClass.*` na raiz de um perfil. **[2026-11-06] Outros perfis** (`other-profile`, "Esta pasta é de outro usuário deste PC e não pode ser liberada."): tudo em `<pasta de perfis>\<nome>` em que a pasta de perfis é a `Users` que contém `os.homedir()` e `<nome>` não é o do usuário nem `Public` (que fica liberado). Junções do sistema (`Documents and Settings`, `Application Data`, `Meus Documentos` etc.) seguem a regra do `realpath`: só aparecem se o destino estiver dentro da raiz e não for bloqueado.
- **macOS** (sem diferenciar maiúsculas): `/System`, `/Library`, `/private`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/tmp`, `/cores`, `/dev`, `/opt`, `/Applications`, `/Network`, `~/Library` e, em qualquer nível, `.Trash`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `.DocumentRevisions-V100`, `.TemporaryItems`.
- **Linux** (diferencia maiúsculas): `/bin`, `/boot`, `/dev`, `/etc`, `/lib`, `/lib32`, `/lib64`, `/libx32`, `/proc`, `/root`, `/run`, `/sbin`, `/srv`, `/sys`, `/usr`, `/var`, `/snap`, `/tmp`, `/opt`, `/lost+found`, `~/.config`, `~/.local`, `~/.cache`, `~/snap`, `~/.var` e, em qualquer nível, `.Trash`, `.Trash-<uid>` e `lost+found`.
- **Todos:** pastas de credenciais em qualquer nível (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.password-store`), qualquer nome começando com `.arkivo-` (inclui `.arkivo-parciais` do backup e `.arkivo-fs-parciais` deste recurso) e `extraBlocked`.
- A pasta do **backup** (§4 Organização) **pode** ser liberada (ver no celular as fotos já salvas é útil); o `.arkivo-parciais` dentro dela continua bloqueado.
- Na listagem, itens bloqueados, links para fora da raiz e nomes que não passam em `checkFsName(_, 'reference')` são **omitidos** e contados em `omitted`; pedir esses itens direto → `FORBIDDEN_PATH`.

### 10.3 Erros

Formato igual ao da API: `{ "error": { "code", "message" } }` (`FsErrorBody`). Na LAN o status HTTP segue `FS_ERROR_STATUS`. No remoto o erro vem **dentro** do envelope (`FsRpcResult = { ok: false, error }`) e o status HTTP da API é `200`: a API não fica sabendo se a operação deu certo. Mensagens padrão em `FS_ERROR_MESSAGES`.

| Código | LAN | Quando |
|---|---|---|
| `VALIDATION_ERROR` | 400 | parâmetro ausente ou malformado |
| `INVALID_NAME` | 400 | nome novo fora das regras de criação |
| `NOT_FOUND` | 404 | o item não existe |
| `NOT_A_DIRECTORY` / `IS_A_DIRECTORY` | 400 | `list` num arquivo / `download` ou `thumb` de pasta |
| `FORBIDDEN_PATH` | 403 | caminho inválido, bloqueado, link para fora da raiz; a raiz em si em `rename`/`move`/`trash` |
| `PERMISSION_DENIED` | 403 | o SO negou (`EACCES`/`EPERM` que não seja arquivo em uso) |
| `ROOT_REMOVED` | 410 | `rootId` desconhecido (raiz removida) |
| `ROOT_UNAVAILABLE` | 503 | unidade desconectada |
| `FS_DISABLED` | 403 | "Acesso pelo celular" desligado no PC |
| `CONFLICT` | 409 (**412** no `PUT` de envio) | já existe item com o nome (`onConflict=fail`) |
| `HASH_MISMATCH` | 409 | envio chegou com SHA-256 diferente (§4.1) |
| `CHANGED` | 409 | o arquivo mudou no PC durante o preparo de um download remoto |
| `INVALID_MOVE` | 422 | pasta para dentro dela mesma |
| `CROSS_DEVICE` | 422 | `move` entre volumes diferentes (`EXDEV`) |
| `TRASH_UNAVAILABLE` | 422 | volume sem Lixeira |
| `NO_THUMBNAIL` | 404 | sem prévia para o tipo |
| `NO_SPACE` | 507 | disco do PC cheio |
| `TOO_LARGE` | 413 | acima do limite do remoto |
| `BUSY` | 423 | mesmo envio em outra conexão, `requestId` em execução, arquivo em uso por outro programa (`EBUSY`, `EPERM` de arquivo aberto no Windows), fila de miniaturas cheia |
| `RATE_LIMITED` | 429 | excesso de pedidos (§10.10) |
| `UNSUPPORTED_OP` | 400 | `op` desconhecida (celular mais novo que o PC) |
| `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403 | assinatura inválida, nonce repetido (LAN) / celular fora da conta |
| `INTERNAL` | 500 | outros |

No `PUT` de envio, `409` continua significando **só** hash diferente (§4.1); conflito de nome usa `412` com código `CONFLICT` (`FS_UPLOAD_NAME_CONFLICT_STATUS`).

### 10.4 Operações

Tipos em `fs.ts`. O PC valida **toda** entrada com `parseFsRequest` (nas duas vias), que normaliza caminhos e nomes e já devolve o código de erro certo.

**Idempotência:** as operações que mudam o disco (`mkdir`, `rename`, `move`, `trash`, `upload`) levam `requestId` (16+ bytes aleatórios em base64url, `randomFsId()`), gerado pelo celular **uma vez por ação do usuário** e repetido em toda nova tentativa. O PC guarda a resposta por `(phoneId, requestId)` durante `FS_IDEMPOTENCY_TTL_MS` (10 min, em memória) e, se o mesmo `requestId` chegar de novo, **devolve a resposta guardada sem executar de novo** (mesmo se vier pela outra via). `requestId` ainda em execução → `BUSY`. No envio pela LAN o `uploadId` faz esse papel.

| `op` | Parâmetros | Resposta | Regras |
|---|---|---|---|
| `roots` | — | `FsRootsResponse { roots, pcName, platform }` | `FS_DISABLED` se desligado. Raízes na ordem em que foram adicionadas. |
| `list` | `rootId, path, cursor?, limit?` (1–500, padrão 200), `sort?` (`name`\|`mtime`\|`size`\|`type`, padrão `name`), `order?` (`asc`\|`desc`), `includeHidden?` (padrão `false`) | `FsListResponse { rootId, path, entries, nextCursor, total, omitted }` | Pastas sempre primeiro; desempate por nome em ordem natural pt-BR (`compareFsEntries`). Sem `includeHidden` somem os ocultos (`.` no começo, atributo oculto do Windows, `FS_LIST_IGNORED_NAMES`). `cursor` é opaco: o PC guarda a listagem ordenada por 60 s e o cursor aponta o deslocamento; cursor vencido → refaz a listagem e usa o deslocamento (pode repetir ou pular itens se a pasta mudou; aceitável). No remoto o PC corta a página para caber em `FS_RPC_MAX_PLAINTEXT_BYTES` (menos itens + `nextCursor`). Em pasta com mais de 100 mil itens, ordenar por `name` não exige `stat` de tudo. |
| `stat` | `rootId, path` | `FsStatResponse { rootId, path, entry }` | `path: ""` = a raiz (o `name` é o rótulo). |
| `thumb` | `rootId, path, size?` (128\|256\|512, padrão 256) | LAN: o JPEG; remoto: `FsThumbResponse { mime, width, height, dataB64, etag }` | Lado maior ≤ `size`, ≤ `FS_THUMB_MAX_BYTES` (96 KiB; o PC baixa a qualidade até caber). Electron: `nativeImage.createThumbnailFromPath` (Windows/macOS: fotos, vídeos e PDF pelas miniaturas do sistema); no Linux só imagens (`nativeImage.createFromPath` + `resize`). Cache no PC por `(realpath, size, mtime, tamanho)`. Até 2 gerações ao mesmo tempo e fila de 32 (acima → `BUSY`). Sem prévia → `NO_THUMBNAIL`. |
| `download` | LAN: rota própria (§10.5). Remoto: `rootId, path` | Remoto: `FsDownloadPrepared { blobId, blobSalt, name, size, mime, mtime, cipherSize, etag }` | Remoto: fluxo do §10.7. Acima de `FS_BLOB_MAX_BYTES` → `TOO_LARGE`. |
| `upload` | LAN: rota própria (§10.5). Remoto: `requestId, rootId, path` (pasta), `name, onConflict?` (`rename`\|`replace`\|`fail`, padrão `rename`), `blobId, blobSalt, size, sha256` | `FsUploadStatusResponse { blobId, status: pending\|done\|failed, received, result?, error? }` | `FsUploadResult = { rootId, path, entry, verifiedHash, renamed }`. Colisão: `rename` = ` (2)`, ` (3)`... antes da extensão (`fsCollisionName`); `replace` = o antigo vai para a Lixeira e o novo fica no lugar (volume sem Lixeira → `TRASH_UNAVAILABLE`); `fail` = `CONFLICT`. O arquivo só aparece no destino depois do SHA-256 conferido (`.part`, `fsync`, `rename` atômico, como §6). |
| `uploadStatus` | `blobId` (só remoto) | `FsUploadStatusResponse` | Para quando o `upload` respondeu `pending`. O PC guarda o estado de cada envio remoto por 24 h. |
| `mkdir` | `requestId, rootId, path` (pasta-mãe), `name` | `FsMkdirResponse { rootId, path, entry, created }` | Já existe pasta com o nome → `200` com `created: false`. Existe arquivo → `CONFLICT`. Não cria pais. |
| `rename` | `requestId, rootId, path, newName` | `FsEntryResponse { rootId, path, entry }` | Mesmo pai. `path: ""` → `FORBIDDEN_PATH` (o rótulo da raiz só muda no PC). Destino existente (outro item) → `CONFLICT`. |
| `move` | `requestId, rootId, paths` (1–100), `toRootId?, toPath` (pasta), `onConflict?` (`fail`\|`rename`\|`skip`, padrão `fail`) | `FsBatchResponse { results: [{ path, ok: true, newPath, skipped? } \| { path, ok: false, error }] }` | Resultado **por item**, sempre `200` (falha parcial é normal). Entre raízes vale se for o mesmo volume (`fs.rename`); volume diferente → `CROSS_DEVICE` no item (a v1 não copia). Pasta para dentro dela mesma → `INVALID_MOVE`. Item que já está no destino → `ok` sem mudar nada. |
| `trash` | `requestId, rootId, paths` (1–100) | `FsBatchResponse` (`newPath: null`) | `shell.trashItem` item a item. Item que já não existe → `NOT_FOUND` no item (o celular trata como "já apagado"). **Antes** de `trashItem` o PC confere se o volume tem Lixeira (§10.11); sem Lixeira → `TRASH_UNAVAILABLE` e nada é apagado. |

### 10.5 Transporte LAN (servidor do PC, porta 47800)

Mesmas exigências do §6 (protocolo antes da assinatura, CORS, só celulares da lista de pares), com assinatura própria:

| Rota | Pedido | Resposta |
|---|---|---|
| `GET /v1/fs/roots` | — | `200 FsRootsResponse` |
| `GET /v1/fs/list?…` | query = campos de `FsListRequest` sem `op` (`fsListQuery`; `includeHidden` vai como `1`/`0`) | `200 FsListResponse` |
| `GET /v1/fs/stat?rootId=&path=` | | `200 FsStatResponse` |
| `GET /v1/fs/thumb?rootId=&path=&size=` | `If-None-Match` opcional | `200 image/jpeg` com `ETag` e `Cache-Control: private, max-age=300`; `304` |
| `GET`/`HEAD /v1/fs/download?rootId=&path=` | `Range: bytes=<início>-[<fim>]` e `If-Range: <etag>` opcionais | `200`/`206` com `Content-Type` (mime), `Content-Length`, `Accept-Ranges: bytes`, `Content-Range` (no 206), `ETag: "<size>-<mtimeMs>"`, `Last-Modified`, `Content-Disposition: attachment; filename*=UTF-8''<nome>`; faixa inválida → `416` |
| `HEAD /v1/fs/upload/:uploadId?onConflict=&name=&path=&rootId=` | `uploadId` = `randomFsId()` do celular | `200` + `X-Arkivo-Received` |
| `PUT /v1/fs/upload/:uploadId?onConflict=&name=&path=&rootId=` | corpo binário, `X-Arkivo-Hash`, `Content-Range`/`Content-Length` (§4.1) | regras do §4.1 (`202`, `416`, `423`, `409` = hash, `400` corpo curto, `411`, `507` com a folga de 1 GiB do §6); último pedaço → `200 FsUploadResult`; nome em uso com `onConflict=fail` → `412 CONFLICT` (conferido no primeiro pedaço **e** no final) |
| `DELETE /v1/fs/upload/:uploadId?rootId=` | cancela | `204` (apaga o `.part`; idempotente) |
| `POST /v1/fs/mkdir`, `/rename`, `/move`, `/trash` | corpo JSON = o pedido **com** `op` (`FsMkdirRequest` etc.), `Content-Type: application/json`, até `FS_LAN_JSON_MAX_BYTES` (64 KiB; acima → `413`) | `200` com a resposta da operação; `op` diferente da rota → `400` |

- **Envio pela LAN:** o `.part` fica em `<raiz>/.arkivo-fs-parciais/<uploadId>.part` (mesmo volume do destino, para o `rename` ser atômico; pasta com atributo oculto no Windows, apagada quando vazia), com `<uploadId>.json` ao lado (`rootId`, `path`, `name`, `onConflict`, hash, tamanho, `phoneId`, `createdAt`). Todo `HEAD`/`PUT` do mesmo `uploadId` precisa da mesma query e do mesmo hash; diferente → `400`. Raiz removida no meio → `ROOT_REMOVED` e o `.part` é apagado. `.part` parado há 7 dias é apagado na partida do PC. Último pedaço repetido depois de concluído → `200` com o mesmo `FsUploadResult` (o PC lembra os `uploadId` concluídos por 24 h).
- **Assinatura** (`lanFsSignaturePayload`, `signLanFsRequest`), cabeçalhos `X-Arkivo-Device`, `X-Arkivo-Ts`, `X-Arkivo-Nonce` e `X-Arkivo-Sig`. Texto canônico, campos unidos por `\n`, UTF-8, sem `\n` no fim:
  ```
  ARKIVO-FS-1
  METHOD
  PATH
  QUERY
  TS
  NONCE
  BODY_SHA256
  ```
  - `METHOD` em maiúsculas. `PATH` = caminho da linha da requisição, sem host e sem query, como no §3.3 (ex.: `/v1/fs/upload/<uploadId>`).
  - `QUERY` = `canonicalFsQuery(parâmetros)`: chaves em ordem, `chave=valor` com codificação estrita RFC 3986 (`fsEncodeComponent`, que também codifica `!'()*`), unidas por `&`, sem `?`; vazio se não houver. O celular **manda na URL exatamente essa query**. O PC lê a query recebida com `parseFsQuery` (chave repetida ou codificação inválida → `400`), recalcula `canonicalFsQuery` e assina por cima disso: um cliente HTTP que recodifique a URL não quebra a assinatura.
  - `TS` = `X-Arkivo-Ts` (unix ms, janela de 120 s como §3.3).
  - `NONCE` = `X-Arkivo-Nonce`, 16 bytes aleatórios em base64url (`LAN_FS_NONCE_RE`). O PC guarda os nonces vistos por 240 s e recusa repetido com `401` (anti-replay, que as rotas do backup não têm). Ausente ou malformado → `401`.
  - `BODY_SHA256`: `POST` = SHA-256 em hex minúsculo dos **bytes** do corpo recebido (o PC calcula); `PUT` de envio = o valor de `X-Arkivo-Hash` (arquivo inteiro, como §3.3); `GET`/`HEAD`/`DELETE` = vazio.
  - Chave e formato de `X-Arkivo-Sig` iguais ao §3.3; o PC compara em tempo constante (`verifyHmacSha256Base64` ou `timingSafeEqual`). O prefixo `ARKIVO-FS-1` separa este texto do texto do backup: uma assinatura de um não vale no outro. As rotas do §6 não mudam.
- **CORS** (§6): acrescentar `POST, DELETE` em `Access-Control-Allow-Methods`; `X-Arkivo-Nonce`, `Range`, `If-Range`, `If-None-Match` em `Access-Control-Allow-Headers`; `Content-Range, Accept-Ranges, Content-Length, Content-Disposition, ETag` em `Access-Control-Expose-Headers`.
- **App nativo:** chamadas pelo `CapacitorHttp`, como no backup; downloads grandes direto para arquivo (`Filesystem.downloadFile` com os cabeçalhos assinados; cada retomada com `Range` é um pedido novo, com nova assinatura).
- **Privacidade na LAN:** como o backup (§6), é HTTP sem cifra na rede de casa: nomes e conteúdo andam em claro no Wi-Fi. A assinatura garante autenticidade e impede replay, não sigilo (TODO `fs-lan-cifrada`, §10.12).
- `GET /v1/ping` passa a incluir `capabilities: ["fs"]` quando a build tem o recurso (mesmo com o interruptor desligado; o estado vem de `roots`).

### 10.6 Transporte remoto: RPC cifrado pela API

```
Celular ──POST /v1/fs-rpc/:pcDeviceId { envelope }──► API ──WS fs.request──► PC
Celular ◄────────────── 200 { envelope } ───────────── API ◄──WS fs.response── PC
```

**Chaves** (`deriveFsE2eKeys(pairKey, pcDeviceId)`): `HKDF-SHA256(ikm = pairKey (32 bytes), salt = "arkivo-fs-e2e/1", info = "arkivo-fs-e2e/1/rpc|<pcDeviceId>")` → AES-256-GCM. Os dois lados derivam a mesma chave; guarde a instância (`FsE2eKeys`) em memória.

**Envelope (`FsEnvelope`, JSON):**
```json
{ "v": 1, "pc": "<pcDeviceId>", "phone": "<phoneDeviceId ou *>", "rid": "<16 bytes b64url>", "typ": "req|res|evt",
  "ts": 1780000000000, "n": "<nonce 12 bytes b64url>", "ct": "<cifrado + tag b64url>" }
```
- `ct` = AES-256-GCM (tag de 128 bits) do JSON do pedido (`FsRequest`), da resposta (`FsRpcResult`) ou do evento (`FsEvent`). Nonce aleatório de 12 bytes por mensagem.
- **AAD** (`fsEnvelopeAad`) = `arkivo-fs-e2e/1\n<pc>\n<phone>\n<rid>\n<typ>\n<ts>`: mudar qualquer campo do cabeçalho faz a abertura falhar. `typ` na AAD impede refletir uma resposta como pedido.
- **Anti-replay:** quem abre (`openFsEnvelope`) recusa `ts` fora de ±`FS_E2E_MAX_SKEW_MS` (120 s) do relógio local (`EXPIRED`) e `rid` repetido dentro da janela (`FsReplayGuard`, chave `phone|typ|rid`, registrada só **depois** de decifrar, para um envelope forjado não "queimar" um `rid` legítimo). A resposta repete o `rid` do pedido; o celular abre com `typ: 'res'`, `phone` = o dele e `rid` = o do pedido. Nova tentativa = **novo envelope e novo `rid`**, com o mesmo `requestId` dentro (idempotência, §10.4).
- Limites: envelope serializado ≤ `FS_RPC_MAX_ENVELOPE_BYTES` (256 KiB); texto claro ≤ `FS_RPC_MAX_PLAINTEXT_BYTES` (180 KiB; `sealFsEnvelope` lança `TOO_LARGE`).

**API: `POST /v1/fs-rpc/:pcDeviceId`** (usuário), corpo `FsRpcHttpRequest = { envelope }` (limite próprio de 320 KiB no `express.json` desta rota):
1. Forma com `parseFsEnvelope` → senão `400`. Exige `envelope.pc == :pcDeviceId`, `typ == "req"` e `phone` = um celular **da conta** (`403` se não). PC da conta (`404` se não existe ou foi revogado). PC sem `"fs"` em `Device.capabilities` → `409 CONFLICT` ("Atualize o Arkivo para PC").
2. PC sem WebSocket aberto → `503 PC_OFFLINE`. Mais de `FS_RPC_MAX_PENDING_PER_PC` (8) pendentes para o PC → `429 QUOTA_EXCEEDED`.
3. Gera `rpcId` aleatório, guarda o pedido pendente em memória (instância única, como o hub) e manda ao PC `fs.request { rpcId, phoneDeviceId, envelope }`.
4. Espera `fs.response` com o mesmo `rpcId` por até `FS_RPC_TIMEOUT_MS` (25 s) → senão `504 PC_TIMEOUT`. O WS do PC fechou com o pedido pendente → `503 PC_OFFLINE`.
5. `fs.response { envelope }` → confere `envelope.pc`, `typ == "res"`, o `rid` igual ao do pedido e o tamanho; devolve `200 FsRpcResponse { envelope }`. `fs.response { error: { code } }` → `502 PC_ERROR` com `error.reason`: `E2E_FAILED` (o PC não conseguiu abrir; ex.: celular com `pairKey` velho → o celular busca `GET /v1/pairings/pc-key/:pcDeviceId` e tenta **uma** vez), `CLOCK_SKEW` ("Confira a data e a hora do celular") ou `BUSY`.
- Códigos novos da API: `PC_OFFLINE` (503), `PC_TIMEOUT` (504), `PC_ERROR` (502) (`FsRpcApiErrorCode`; entram em `ApiError` quando a API implementar).
- Limite: 120 RPCs por minuto e 1.200 por hora por conta → `429 QUOTA_EXCEEDED`.
- A API **nunca** abre o envelope, não registra `ct` nem o corpo e não sabe qual operação foi pedida.

**PC:** ao receber `fs.request`, abre com `openFsEnvelope(keys, envelope, { typ: 'req', allowedPhones: <pares>, replay })`, confere `envelope.phone == phoneDeviceId` vindo da API, executa (mesmo despachante da LAN, `via: 'remote'`) e responde `fs.response { rpcId, envelope }` com `sealFsEnvelope(keys, { phone, typ: 'res', rid }, FsRpcResult)`. Falha ao abrir → `fs.response { rpcId, error: { code: 'E2E_FAILED' | 'CLOCK_SKEW' } }` (o PC nunca cifra resposta para pedido que não abriu). Resposta que não cabe: `list` corta a página; outras viram `INTERNAL`.

**Eventos E2E (`fs.event`):** o PC manda `fs.event { envelope }` (`typ: "evt"`, `phone: "*"`, `rid` novo, ≤ `FS_EVENT_MAX_ENVELOPE_BYTES`); a API repassa a todos os celulares da conta como `fs.event { pcDeviceId, envelope }`. Conteúdo: `FsEvent` (`rootsChanged`, `uploadDone`, `uploadFailed`, `downloadFailed`). O celular abre com `typ: 'evt'`, `phone: '*'`. Eventos só aceleram: o celular sempre pode consultar (`roots`, `uploadStatus`, `GET /v1/fs-blobs/:id`).

### 10.7 Conteúdo grande remoto: blobs cifrados no spool

**Cifra do blob** (`FsE2eKeys.blobKey(blobId, blobSalt, plainSize)` → `FsBlobKey`): `HKDF-SHA256(ikm = pairKey, salt = blobSalt (16 bytes aleatórios, newFsBlobSalt), info = "arkivo-fs-e2e/1/blob|<pcDeviceId>|<blobId>")` → AES-256-GCM. O arquivo é cortado em pedaços de `FS_BLOB_SEGMENT_BYTES` (1 MiB; o último pode ser menor; arquivo vazio = 1 pedaço vazio). Pedaço `i` = AES-GCM com nonce = 4 bytes zero ‖ `i` em 64 bits big-endian e AAD = `arkivo-fs-blob/1\n<blobId>\n<i>\n<1 se último, senão 0>\n<plainSize>`; sai o texto + 16 bytes de tag. O blob é a concatenação dos pedaços (`fsBlobCipherSize`, `fsBlobPlainSize` e `fsBlobSegment` dão tamanhos e deslocamentos para ler e retomar com `Range`).
- A AAD impede reordenar, trocar pedaços entre blobs e truncar (o tamanho total e a marca de último estão nela).
- A chave é única por blob, então o nonce determinístico é seguro, e a cifra é **determinística**: quem envia calcula o SHA-256 do blob cifrado numa primeira passada e depois gera de novo qualquer pedaço, idêntico, para os `PUT` e retomadas (§4.1).
- O `blobSalt` só viaja dentro de envelopes cifrados.

**API: recurso `FsBlob`** (Mongo: `{ userId, pcDeviceId, direction: toPc|toPhone, status, cipherSize, cipherHash, bytesReceived, reservedBytes, createdAt, updatedAt, expiresAt }`; nenhum nome, nenhum metadado do arquivo; disco em `SPOOL_DIR/<userId>/fsblob-<id>.part|.blob`):
- `POST /v1/fs-blobs` (celular: `{ pcDeviceId, cipherSize }`, direção `toPc`; PC: `{ cipherSize }`, direção `toPhone`) → `201 FsBlobInfo`. Reserva `cipherSize` **nas mesmas cotas do relay** (`reserveSpool`: `RELAY_USER_QUOTA_BYTES`, `RELAY_GLOBAL_QUOTA_BYTES`, `RELAY_MIN_FREE_DISK_BYTES` → `507 QUOTA_EXCEEDED` com `reason`). `cipherSize` acima de `FS_BLOB_MAX_BYTES` (env nova, padrão = `RELAY_MAX_FILE_BYTES`) → `413`. Mais de `FS_BLOB_MAX_ACTIVE_PER_USER` (10) ativos → `429`. Limite: 60 criações por hora por conta.
- `HEAD`/`PUT /v1/fs-blobs/:blobId/content` (só quem criou): regras do §4.1 com `X-Arkivo-Hash` = SHA-256 do **blob cifrado** em todo `PUT` (fixado no primeiro pedaço; outro valor depois → `409`). Último pedaço com hash certo → `ready`; errado → `409` e o blob volta a zero. Reaproveita o código do `PUT /relay` (`planChunkUpload`, `Spool.writeChunk`, `finalize`).
- `GET /v1/fs-blobs/:blobId` (os dois lados) → `FsBlobInfo`.
- `GET /v1/fs-blobs/:blobId/content` (só o destinatário: o PC no `toPc`, qualquer celular da conta no `toPhone`) → conteúdo com `Range` (`206`), como `GET /relay/:id/download`; o primeiro download muda para `downloading`. Fora de `ready`/`downloading` → `410`.
- `DELETE /v1/fs-blobs/:blobId` (os dois lados) → `204`: pelo destinatário = "recebi" (`done`); pelo criador = cancelar (`failed`). Apaga do spool e devolve a cota na hora. Idempotente.
- `POST /v1/fs-blobs/:blobId/fail` (criador) `{ reason }` → `204` (ex.: o arquivo mudou no PC).
- **TTL curto:** `FS_BLOB_TTL_MINUTES` (60) **sem atividade** (todo `PUT`/`GET` renova `expiresAt`) → `expired`, apaga e devolve a cota; job a cada 5 min. Revogar o PC ou apagar a conta apaga os blobs dele na hora.
- WS `fs.blob.updated { blob: FsBlobInfo }` aos celulares da conta: ao criar, ao ficar `ready`, a cada ~10% de um blob `toPhone` em envio, e em `done`/`failed`/`expired`.

**Download remoto (PC → celular):**
1. Celular: RPC `download { rootId, path }`.
2. PC: valida, `stat`, `cipherSize = fsBlobCipherSize(size)`, `POST /v1/fs-blobs { cipherSize }`, gera `blobSalt` e responde logo (`FsDownloadPrepared`). Em segundo plano: 1ª passada cifra e calcula o SHA-256 do blob; 2ª envia com `PUT` em pedaços de 8 MiB (retomando com `HEAD`). Se `size`/`mtime` mudarem entre as passadas → `POST /v1/fs-blobs/:id/fail` e `fs.event downloadFailed { error: CHANGED }`. Erro de disco/permissão → `fail` + `downloadFailed` com o código.
3. Celular: acompanha por `fs.blob.updated` ou `GET /v1/fs-blobs/:id` ("Preparando no PC… 40%"); em `ready`, baixa com `Range`, abre cada pedaço (`openSegment`, que garante a integridade), grava e no fim chama `DELETE /v1/fs-blobs/:id`. Um pedaço que não abre → baixa aquele trecho de novo uma vez; repetiu → descarta e mostra erro.

**Envio remoto (celular → PC):**
1. Celular: `POST /v1/fs-blobs { pcDeviceId, cipherSize }` → `blobId`; gera `blobSalt`; 1ª passada: SHA-256 do arquivo (texto claro) e do blob cifrado; 2ª: `PUT` em pedaços (§4.1) até `ready`.
2. Celular: RPC `upload { requestId, rootId, path, name, onConflict, blobId, blobSalt, size, sha256 }`.
3. PC: confere destino e conflito **antes** de baixar (`CONFLICT` sem gastar banda), baixa `GET /v1/fs-blobs/:id/content` (retomando com `Range`), decifra pedaço a pedaço para `<raiz>/.arkivo-fs-parciais/blob-<blobId>.part`, confere `size` e o SHA-256 do texto claro (`HASH_MISMATCH`), coloca no destino e chama `DELETE /v1/fs-blobs/:id`. Terminou em até `FS_UPLOAD_COMMIT_WAIT_MS` (15 s) → responde `status: "done"` com o resultado; senão `pending` e avisa depois com `fs.event uploadDone`/`uploadFailed` (`uploadStatus` responde a qualquer momento).
4. Pouco espaço no PC → `NO_SPACE`; o blob fica na API até o TTL (o celular pode repetir o `upload` com o mesmo `blobId` depois de o usuário liberar espaço).

### 10.8 Mudanças no WebSocket (§5)

- **API → PC:** `fs.request { rpcId, phoneDeviceId, envelope }`.
- **PC → API:** `fs.response { rpcId, envelope?, error?: { code: 'E2E_FAILED' | 'CLOCK_SKEW' | 'BUSY' } }` e `fs.event { envelope }`; `pc.status` ganha `capabilities?: string[]`.
- **API → celular:** `fs.event { pcDeviceId, envelope }` e `fs.blob.updated { blob }`; `device.status` ganha `capabilities?: string[]`.
- O `maxPayload` do hub sobe de 64 KiB para **512 KiB**; `parseClientMessage` limita por tipo: `pc.status` ≤ 16 KiB (como hoje), `fs.response` ≤ 300 KiB, `fs.event` ≤ 40 KiB; o que vier de celular continua ignorado.
- Quem não conhece os tipos novos os ignora (o PC e o celular atuais já fazem isso).

### 10.9 Versionamento e capacidades (§9)

- `PROTOCOL_VERSION` **continua `1`**: só há rotas, eventos e campos opcionais novos (§9.7, "não sobe"). As rotas e o texto assinado do backup (§3.3, §6) não mudam; o texto novo vale só para `/v1/fs/*` e leva a versão do subprotocolo no prefixo (`FS_PROTOCOL_VERSION = 1`). Uma mudança incompatível do subprotocolo vira capacidade nova (`fs2`), sem subir o protocolo geral.
- **Capacidades** (`CAPABILITIES`, `hasCapability`):
  - PC: `"fs"` em `GET /v1/ping` (`LanPingResponse.capabilities`), em `pc.status.capabilities` e em `PATCH /v1/devices/pc/self { capabilities }`. A API grava em `Device.capabilities` (campo novo; **[2026-11-04]** no celular, o que ele anunciar, §11.6) e repassa em `device.status`.
  - API: `"fs-rpc"` em `HealthResponse.capabilities` (`GET /v1/health`).
- Celular: só mostra os arquivos do PC se o PC anunciar `fs`; sem `fs` → "Atualize o Arkivo para PC para ver os arquivos pelo celular". Remoto só se a API anunciar `fs-rpc` (senão, só na mesma rede). `Device` sem `capabilities` (API antiga) = nenhuma.

### 10.10 Segurança, privacidade e limites

- **API: nunca nomes de arquivo, caminhos, listas ou conteúdo em texto claro.** Logs de `fs-rpc` só com `userId`, `pcDeviceId`, `phoneDeviceId`, `rpcId`, tamanho do envelope, latência e resultado (`ok`/`timeout`/`offline`/`pc_error`); de `fs-blobs` só id, direção, tamanhos e status. Corpo e query dessas rotas não vão para o log. A API não grava cada RPC na auditoria da conta (só contadores para os limites).
- **PC:** só aceita celulares da lista de pares (§3.3) nas duas vias. Limites por celular: 20 pedidos/s de leitura (`roots`, `list`, `stat`, `thumb`), 5/s de mudança, 4 downloads LAN simultâneos e 2 envios remotos simultâneos → `RATE_LIMITED`. Nunca segue link para fora da raiz, nunca apaga em definitivo, nunca cria nada fora de uma raiz (os `.part` ficam dentro dela).
- **Auditoria local no PC** (`fs-audit.json` na pasta de dados do app; últimas 5.000 entradas ou 90 dias; `FsAuditEntry`): toda operação de mudança e todo download e envio, com celular, via (`lan`/`remote`), raiz, caminho, destino, quantidade, bytes e resultado. Navegação (`list`, `stat`, `thumb`) entra agrupada: uma entrada `browse` por celular a cada 10 min. Fica **só no PC** (os caminhos em claro são do próprio usuário), visível em "Pastas liberadas → O que o celular fez", com "Limpar histórico". Não vai para a API.
- **Celular:** confirma **sempre** antes de `trash` (com a quantidade) e antes de `move` com mais de 1 item ou com pasta; `replace` no envio também pede confirmação. Ações em lote mostram o resultado por item ("8 movidos, 2 com erro").
- Arquivos baixados ficam na pasta de downloads do app (Android: `Download/Arkivo`; iOS: pasta do app visível no Arquivos), não na galeria, salvo se o usuário tocar em "Salvar na galeria".
- Miniaturas e listas não ficam em cache persistente no celular (só memória da sessão), para não espalhar dados do PC.

### 10.11 Notas de implementação no PC

- **Lixeira:** no Windows, unidades removíveis (pen drive, cartão) e de rede **não têm Lixeira**, e o `IFileOperation` usado pelo `trashItem` pode apagar em definitivo. Antes de `trashItem` (e do `replace`), o PC confere o tipo do volume (`[System.IO.DriveInfo]::DriveType` ou `Get-Volume`, com cache por letra): só `Fixed` tem Lixeira; os demais → `TRASH_UNAVAILABLE` (e `FsRootInfo.trashAvailable = false`). No macOS/Linux, volume de rede também → `TRASH_UNAVAILABLE`. Na dúvida, recusa.
- **OneDrive "somente online":** ler o arquivo dispara o download dele no PC; o PC não gera miniatura de arquivo com atributo `RECALL_ON_DATA_ACCESS`/`OFFLINE` (`hasThumb: false`).
- **Arquivo em uso** (`EBUSY`, `EPERM` com arquivo aberto) → `BUSY` ("Feche o arquivo no PC e tente de novo").
- Raiz inacessível continua na lista com `available: false` (o usuário remove se quiser); a checagem é feita ao listar raízes e em cada operação.
- `fs.event rootsChanged` (§10.6) ao adicionar, remover ou renomear raiz e ao mudar o interruptor; na LAN o celular só recarrega `roots`.

### 10.12 E2E de verdade (TODO `fs-e2e-real`): o limite honesto de hoje

**O que a cifra protege hoje:** quem tem acesso só ao spool em disco, aos logs, a cópias do tráfego depois do TLS ou a um vazamento do banco **sem** a `PAIRKEY_ENC_KEY` não consegue ler nomes, listas nem conteúdo.

**O que ela não protege:** a API guarda o `pairKey` cifrado com `PAIRKEY_ENC_KEY` (§3.3) e o decifra para reentregar ao celular após novo login. Portanto **o operador do servidor (ou quem invadir a API e tiver a `PAIRKEY_ENC_KEY`) consegue derivar as chaves deste recurso** e ler o que passa pelo RPC e pelos blobs. Enquanto isso valer, textos legais e interface **não** podem dizer "nem o Arkivo consegue ver"; podem dizer "cifrado entre o celular e o seu PC; o servidor só repassa", com essa ressalva. O `pairKey` também é o mesmo para todos os celulares da conta: o `phone` do envelope identifica, mas não prova, qual celular pediu.

**Caminho proposto (próxima versão do subprotocolo, capacidade `fs2`):**
1. No QR, o PC acrescenta um segredo local `s` (16 bytes) e a impressão digital da sua chave pública ECDH P-256 (`&k=<sha256 da chave pública, b64url>&s=<...>`). O QR é lido pela câmera: a API não vê.
2. O celular gera um par ECDH P-256 (WebCrypto em todos os alvos; X25519 ainda não é universal), manda a chave pública no `claim` junto com `HMAC(s, chave pública do celular)`. O PC confere o HMAC (sem `s` a API não consegue trocar a chave do celular) e o celular confere a chave pública do PC pela impressão digital do QR.
3. Os dois derivam `e2eKey = HKDF(ECDH)`, guardada só nos aparelhos (Keystore/Keychain no celular, `safeStorage` no PC), uma por celular. RPC e blobs passam a usar `e2eKey` no lugar do `pairKey`.
4. Consequência de produto: celular novo ou reinstalado **precisa ler de novo o QR do PC** (ou receber a chave de outro celular da conta) para acessar os arquivos de fora de casa; a API não consegue mais reentregar.

Outros TODO: `fs-lan-cifrada` (rota LAN `POST /v1/fs/rpc` aceitando o mesmo envelope, para nomes e listas não andarem em claro no Wi-Fi; downloads e envios LAN pelos mesmos pedaços cifrados), cópia entre volumes no `move`, download remoto em fluxo (o celular baixar enquanto o PC ainda envia), várias instâncias da API (pedidos pendentes e hub fora da memória).

### 10.13 UX resumida (pt-BR)

**PC: tela "Pastas liberadas"** (item novo no menu):
- Título "Pastas liberadas"; texto: "O celular pode ver, baixar, enviar, renomear, mover e apagar arquivos nestas pastas. O que for apagado vai para a Lixeira do PC."
- Interruptor "Acesso pelo celular". Desligado: "O celular não vê nenhuma pasta."
- Botão "Adicionar pasta" (seletor do sistema). Recusas: `FS_BLOCK_MESSAGES`, "Esta pasta já está liberada.", "Esta pasta está dentro de "<rótulo>", que já está liberada.", "Esta pasta contém "<rótulo>", que já está liberada. Remova "<rótulo>" antes.", "Limite de 32 pastas.", **[2026-11-06]** "Esta pasta já está liberada: ela fica em "<rótulo>", a unidade C: inteira.", "Esta unidade já está liberada inteira.". Escolher a raiz de uma unidade no seletor abre o mesmo aviso de "Liberar inteira".
- **[2026-11-06] Seção "Unidades deste PC":** cada unidade pronta (as que não estão prontas, como leitor de cartão vazio, ficam de fora), com letra, nome do volume, tipo legível ("Disco interno", "Pen drive / HD externo", "Unidade de rede", "CD/DVD"), espaço livre/total, a marca "Liberada inteira" ou "N pastas liberadas" e, sem Lixeira, "Sem Lixeira: o celular não pode apagar aqui". Ações: **"Liberar inteira"** (aviso e confirmação, §10.2) e **"Escolher pasta…"** (seletor do sistema já na unidade). A lista é enumerada de novo ao abrir a tela, quando a janela ganha foco e a cada ~10 s com a tela aberta. A tela manda só o `id` da unidade; o processo principal enumera de novo, monta o caminho e confere tudo (a tela nunca escolhe um caminho livre). No macOS/Linux, a seção lista os volumes montados (`/Volumes`, `/media`, `/run/media`, `/mnt`) só com "Escolher pasta…".
- Cada pasta: rótulo, caminho, unidade; "Indisponível: unidade desconectada"; "Sem Lixeira: o celular não pode apagar aqui"; ações "Renomear" e "Remover" (confirmação: "Parar de liberar "<rótulo>"? Os arquivos continuam no PC.").
- Seção "O que o celular fez": "<celular> enviou "foto.jpg" para Fotos/2026 · 14:32", "<celular> mandou 3 itens para a Lixeira · ontem", "<celular> navegou pelas pastas"; marca "Pela internet"/"Na rede de casa"; botão "Limpar histórico".

**Celular: aba "PC"**:
- Cabeçalho com o nome do PC e o estado: "Na mesma rede", "Pela internet", "PC desligado".
- "Pastas liberadas" (rótulo + unidade). Vazia: "Nenhuma pasta liberada. No programa do PC, abra "Pastas liberadas" e escolha as pastas."
- Dentro de uma pasta: caminho no topo (toque para voltar), ordenar (Nome, Data, Tamanho, Tipo), "Mostrar ocultos", itens com miniatura, "Mostrando 200 de 1.350" + "Carregar mais", e "N itens não podem ser mostrados" quando `omitted > 0`.
- Toque: abre a pasta / mostra a prévia (miniatura 512) / "Baixar". Toque longo: seleção. Ações: "Baixar", "Renomear", "Mover", "Apagar", "Nova pasta", "Enviar arquivo".
- Confirmações: "Mandar 3 itens para a Lixeira do PC? Dá para recuperar na Lixeira do PC." · "Mover 3 itens para "Fotos/2025"?" · "Já existe "foto.jpg". Substituir (o antigo vai para a Lixeira) ou manter os dois?"
- Remoto: "Preparando no PC…", "Baixando…", "Pela internet, os arquivos passam pelo servidor do Arkivo cifrados." Grande demais: mensagem de `TOO_LARGE`.
- Erros: `FS_ERROR_MESSAGES`; `PC_OFFLINE`: "O PC está desligado ou sem internet."; `PC_TIMEOUT`: "O PC demorou para responder. Tente de novo."

## 11. Enviar para o celular [2026-11-04]

Tipos e constantes em `packages/shared/src/fs.ts` (`FsOutboxItem`, `FsOutboxState`, `FS_OUTBOX_OPS`, `FS_PUSH_*`). Reaproveita o §10 inteiro: as duas vias, a assinatura da LAN, o envelope cifrado, os blobs, os limites por celular e a auditoria local. Até aqui o celular só buscava arquivos do PC; este recurso deixa o envio começar no programa do PC.

### 11.1 Fluxo

1. No PC, o usuário toca em **Escolher arquivos** (seletor do sistema) ou arrasta arquivos para a janela. Com um só celular pareado, vai para ele; com mais de um, o usuário escolhe.
2. O PC confere cada arquivo (§11.3), guarda o item na caixa de saída e manda `fs.event outboxChanged` (§11.5).
3. O celular mostra "Chegaram 3 arquivos do PC" com **Baixar** e **Recusar**. **Nunca grava nada sem o toque do usuário.**
4. O celular baixa pela via do §10.1 (LAN se o ping responde, senão pela internet), grava e confirma com `outboxDone`. O PC mostra o estado de cada arquivo e registra em "O que o celular fez".

### 11.2 Onde o arquivo espera

- **No próprio PC.** A caixa de saída é a lista em `outbox.json` na pasta de dados do app (`writeFileAtomic`, `0600`), que sobrevive a reiniciar. O arquivo em si fica onde está; o caminho absoluto nunca sai do PC.
- **Nada fica guardado a mais no servidor:** o PC precisa estar ligado para o celular baixar, e os textos da interface dizem isso. Pela internet, o conteúdo só passa pelos blobs do §10.7, criados na hora do download, com o TTL curto de lá.
- **Prazo:** `FS_PUSH_TTL_MS` (**7 dias**) a partir da escolha. **Limite:** `FS_PUSH_MAX_ACTIVE` (**200**) itens ativos; os seguintes são recusados com mensagem. Itens encerrados ficam na tela do PC por mais 7 dias (no máximo 200) e podem ser removidos da lista.
- **Nada aqui toca no arquivo do usuário.** Item entregue, recusado, expirado ou cancelado nunca apaga o original.

### 11.3 Bloqueios ao escolher (e de novo a cada entrega)

O processo principal do PC confere **cada caminho** (o renderer só entrega os `File` do evento de soltar; o preload resolve com `webUtils.getPathForFile`, porque `File.path` não existe mais). Recusa com mensagem, por arquivo:
- pasta ("só arquivos nesta versão"), link simbólico ou junção no próprio arquivo (`lstat`), o que não é arquivo comum;
- o que `fsBlockedReason` bloqueia, no caminho recebido e no `realpath`: sistema, dados de programas, credenciais e dados do Arkivo (`FS_PUSH_BLOCK_MESSAGES`);
- `fsBlobCipherSize(tamanho) > FS_PUSH_MAX_BYTES` (**2 GiB**, incluindo a cifra dos blobs). O limite vale **nas duas vias**, para o comportamento não variar;
- arquivo que já está esperando o mesmo celular; nome que não passa em `checkFsName(_, 'reference')`.

A cada entrega o PC confere de novo: **tamanho ou `mtime` diferentes da escolha → `changed`** e não entrega (`CHANGED`). Arquivo apagado, trocado por outra coisa, ou caminho que passou a sair do `realpath` guardado (pasta virou link) → `failed`, com o motivo. Unidade desconectada (a pasta do arquivo sumiu) ou erro de permissão não encerram o item: ele continua esperando e o pedido responde `ROOT_UNAVAILABLE`.

### 11.4 Estados

`FsOutboxState`: `waiting` e `downloading` são ativos; `delivered`, `declined`, `changed`, `expired` e `failed` são finais.

| Estado | Tela do PC | Quando |
|---|---|---|
| `waiting` | Aguardando o celular | escolhido; ou voltou depois de falha passageira, de reiniciar o PC, ou de 15 min sem sinal do celular (`FS_OUTBOX_IDLE_MS`) |
| `downloading` | Baixando N% | o celular pediu o conteúdo. N = bytes entregues (LAN) ou enviados ao servidor (remoto: o PC não vê o trecho servidor → celular, então fica em 100% até o `outboxDone`) |
| `delivered` | Entregue | `outboxDone` |
| `declined` | Recusado | `outboxDecline` |
| `changed` | Arquivo mudou | §11.3 |
| `expired` | Expirou | passou de `expiresAt` esperando |
| `failed` | Falhou | §11.3, com `reason` |

**Cancelar** (no PC, em item ativo) tira o item da lista: o celular passa a receber `NOT_FOUND`. **Sair da conta, desparear ou o PC ser revogado apagam a caixa de saída** (só a lista). Um celular que sai da conta perde os itens dele.

### 11.5 Operações

Validação em `parseFsRequest`. **Só levam o `id` do item (`randomFsId()`, gerado no PC), nunca um caminho**: não há como alcançar nada fora da caixa de saída. Por isso **independem do interruptor "Acesso pelo celular"** e funcionam sem nenhuma pasta liberada (o usuário escolheu o arquivo de forma explícita). As outras operações do §10.4 continuam respondendo `FS_DISABLED`.

Não mudam o disco, então não levam `requestId` e não entram em `FS_MUTATING_OPS`: a idempotência vem do estado do item.

| `op` | Parâmetros | Resposta | Regras |
|---|---|---|---|
| `outboxList` | — | `FsOutboxListResponse { items, pcName }` | Só os itens **deste celular**: ativos e os `changed`/`failed` ainda não dispensados. Conta como leitura (20/s). Não entra na auditoria. |
| `outboxDownload` | `id` (só remoto) | `FsDownloadPrepared` | Fluxo do `download` (§10.7). Repetir enquanto o blob do item existe devolve o mesmo blob. Na LAN, rota de conteúdo própria. |
| `outboxDone` | `id` | `FsOutboxItemResponse { item }` | `waiting`/`downloading` → `delivered`. Em qualquer outro estado devolve o estado atual, sem mudar nada. Conta como mudança (5/s). |
| `outboxDecline` | `id` | `FsOutboxItemResponse { item }` | `waiting`/`downloading` → `declined`. Em `changed`/`failed`, só dispensa o aviso no celular; nos demais, nada muda. Conta como mudança (5/s). |

**Celular errado:** o `NOT_FOUND` é igual ao de um `id` que não existe, nas três operações com `id`, e a lista dele vem vazia. Conteúdo já encerrado também responde `NOT_FOUND`; `changed` responde `CHANGED`.

**LAN** (assinatura e regras do §10.5):

| Rota | Pedido | Resposta |
|---|---|---|
| `GET /v1/fs/outbox` | — | `200 FsOutboxListResponse` |
| `GET`/`HEAD /v1/fs/outbox/download?id=` | `Range` e `If-Range` opcionais | como `GET /v1/fs/download`. `HEAD` não muda o estado. |
| `POST /v1/fs/outbox/done` | `{ op: "outboxDone", id }` | `200 FsOutboxItemResponse` |
| `POST /v1/fs/outbox/decline` | `{ op: "outboxDecline", id }` | `200 FsOutboxItemResponse` |

**Evento:** `FsEvent { kind: "outboxChanged", phoneId }`, cifrado em `fs.event`. Vai quando o PC muda a caixa de saída de um celular (entrou arquivo, cancelou, expirou, o arquivo mudou). Só leva o id do celular de destino, sem nome: o `fs.event` vai para todos os celulares da conta, e o outro ignora.

**Descoberta:** o evento só acelera e se perde com o celular fechado. O celular também consulta `outboxList` **ao abrir o app, ao voltar para a tela, ao reconectar o WebSocket e a cada 30 s com o app aberto** (`FS_PUSH_POLL_MS`), se o PC anuncia `fs-push` e a via permite. A lista fica só em memória (§10.10).

**Auditoria** (§10.10): `outboxDownload`, `outboxDone` e `outboxDecline` entram em "O que o celular fez", com o nome do arquivo (sem raiz nem caminho), `via` e bytes.

**Limites herdados:** pela internet valem os do §10.7. Em especial, 60 blobs criados por hora por conta (`429`, o item volta a esperar e o celular mostra o erro) e as cotas do spool.

### 11.6 Capacidade `fs-push` e compatibilidade

`PROTOCOL_VERSION` continua `1`: só há operações, rotas, campos e eventos novos e opcionais.

- **PC:** anuncia `"fs-push"` junto de `"fs"` no `/v1/ping`, em `pc.status` e no `PATCH /v1/devices/pc/self`, sempre, com o interruptor ligado ou não. O celular só consulta a caixa de saída de um PC com `fs-push`.
- **Celular:** anuncia em `POST /v1/devices/phone { capabilities: ["fs-push"] }`, que roda a cada abertura do app (assim quem atualiza passa a contar). A API grava em `Device.capabilities` e entrega ao PC em `GET /v1/devices/pc/peers` e `peers.changed`.
- **Botão no PC:** só fica ativo se houver celular com `fs-push`. Sem isso (app ou API antigos, não dá para saber), a tela avisa "Atualize o Arkivo no celular para ele poder receber arquivos do PC" e o PC recusa o envio, em vez de falhar em silêncio. Com vários celulares, os sem a capacidade aparecem desativados na escolha.
- **Quem não conhece ignora:** celular antigo ignora `kind` desconhecido em `fs.event`; PC antigo responde `UNSUPPORTED_OP` (remoto) ou `404` (LAN).
- A aba "PC" do celular continua dependendo de `fs`, que independe do interruptor: com ele desligado, a aba aparece e os recebidos não somem.

### 11.7 Celular e PWA

- Aviso na tela Início e seção **Recebidos do PC** na aba PC, com **Baixar tudo**, **Baixar**, **Recusar** e o painel de transferências do §10. Item `changed`/`failed` mostra o motivo e **Dispensar**.
- **Nativo:** grava em `Download/Arkivo` (iOS: Arquivos → Arkivo), como o download do §10.10.
- **PWA:** download do navegador, um por vez. O navegador pode bloquear downloads seguidos sem avisar a página, e não há como detectar isso. Por isso cada arquivo fica com o botão **Salvar** no painel, num toque (que o navegador não bloqueia), até o usuário fechar. Consequência honesta: no PWA, `delivered` significa "o celular recebeu os bytes e pediu para salvar", não que o navegador gravou. Só recebe com o app aberto.
- Gravou mas o `outboxDone` falhou (rede caiu): o arquivo não é baixado de novo, e a confirmação é repetida na próxima consulta.

### 11.8 Segurança: o limite honesto

Valem as ressalvas do §10.12. Em especial, o `pairKey` é o mesmo para todos os celulares da conta: **"um celular só vê o que é dele" é regra do PC, não garantia criptográfica**. O PC filtra pelo `phone` do envelope (remoto) ou por `X-Arkivo-Device` (LAN), que identificam, mas não provam, qual celular pediu. Um celular da mesma conta adulterado conseguiria se passar por outro. O MVP mostra só o PC principal (§4): a caixa de saída de outro PC da conta não aparece no celular.

Na LAN, nomes e conteúdo andam em claro no Wi-Fi, como no §10.5.

### 11.9 UX resumida (pt-BR)

**PC: item "Enviar para o celular"** no menu: área de soltar, botão **Escolher arquivos**, "Só arquivos, até 2 GB cada", o texto "O arquivo espera aqui no PC por até 7 dias e nada fica guardado no servidor. **O PC precisa estar ligado** para o celular baixar, e nada é gravado no celular sem o toque de quem está com ele.", as recusas por arquivo e a lista com os estados do §11.4, ações **Cancelar** (ativos) e **Remover** (encerrados). Arrastar funciona em qualquer tela da janela.

**Celular:** "Chegaram 3 arquivos do PC" / "Chegou 1 arquivo do PC", "Os arquivos esperam no PC, não no servidor. O PC precisa estar ligado para baixar." Recusar pelo aviso da tela Início pede confirmação ("Recusar 3 arquivos? Eles não vão chegar neste celular. Nada muda no PC."). Erros: "O arquivo mudou no PC. Peça para enviar de novo.", "Este arquivo não está mais disponível no PC.", "O PC está desligado ou sem internet. Ligue o PC para baixar."
