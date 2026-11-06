# Arkivo para PC (`@arkivo/pc-agent`)

Programa receptor do Arkivo: fica rodando no computador (na bandeja), recebe fotos, vídeos e documentos do celular, confere cada arquivo por SHA-256 e guarda numa pasta organizada por `AAAA/MM`. Também deixa o celular acessar **pastas liberadas** do PC (ver, baixar, enviar, renomear, mover, mandar para a Lixeira), na mesma rede ou pela internet. Feito com Electron 45 + Node + TypeScript, pensado primeiro para Windows e funcionando também em macOS e Linux.

O contrato com a API e o app do celular está em [`docs/CONTRACT.md`](../../docs/CONTRACT.md). Dúvidas e interpretações do contrato estão em [`CONTRACT_NOTES.md`](./CONTRACT_NOTES.md).

## Estrutura

```
src/
  core/        Node puro, sem Electron (testável com node:test)
    agent.ts          orquestrador: liga tudo e expõe o estado observável da UI
    config-store.ts   config.json + segredos cifrados (interface SecretCipher)
    api-client.ts     fetch nativo com "Authorization: Device <token>"
    pairing.ts        QR (300 s, renova sozinho), WS anônimo + polling de 2 s
    realtime.ts       WebSocket do PC com reconexão exponencial e pc.status
    lan-server.ts     servidor HTTP da LAN (porta 47800), HMAC, retomada, 507
    lan-auth.ts       verificação HMAC (timingSafeEqual, janela de 120 s, peers)
    storage.ts        AAAA/MM no fuso local, colisão " (2)", rename atômico, SHA-256
    relay-worker.ts   fila serial do relay: Range, hash, organiza, ack/fail+backoff
    activity-log.ts   últimos 200 eventos, contagem por mês, velocidade média
    net-info.ts       IPv4 privados (RFC 1918) e espaço livre (fs.statfs)
    lan-http.ts       CORS, corpo protegido e Content-Range comuns às rotas LAN
    fs-*.ts           pastas liberadas (contrato §10) e caixa de saída (§11), ver as seções abaixo
    *.test.ts         testes (node:test)
  common/ipc.ts  canais e tipos do IPC (main ⇄ preload ⇄ renderer)
  main/          processo principal do Electron
    main.ts           janela, bandeja, instância única, IPC validado
    preload.ts        contextBridge → window.arkivo (sandbox, sem Node)
    adapters.ts       safeStorage, ws e qrcode atrás das interfaces do core
    fs-electron.ts    shell.trashItem e nativeImage (Lixeira e miniaturas das pastas liberadas)
    autostart.ts      iniciar com o sistema (setLoginItemSettings / .desktop no Linux)
  renderer/      UI em HTML/CSS/TS sem framework (design Nocturne, textos do protótipo)
build/installer.nsh   regra de firewall no instalador do Windows
scripts/copy-renderer.mjs  copia HTML/CSS e embute fontes Inter + ícones Phosphor
```

## Rodar em desenvolvimento

Pré-requisitos: Node 22+, dependências instaladas na raiz do monorepo (`npm install`).

```bash
# na raiz do repositório
npm install
npm run build:shared

# API local (outro terminal): apps/api em http://localhost:3000
npm run dev:api

# receptor do PC
cd apps/pc-agent
npm run dev                       # compila e abre o Electron com DevTools
ARKIVO_API_URL=http://192.168.0.5:3000 npm run dev   # API em outra máquina
```

- Em dev a API padrão é `http://localhost:3000`; no app empacotado é `https://api.arkivo.com`. `ARKIVO_API_URL` sobrescreve as duas.
- Em dev o "iniciar com o sistema" não é registrado no SO (para não abrir o Electron cru no login); a preferência é salva normalmente.
- Para simular um segundo PC na mesma máquina, rode com outro diretório de dados: `electron . --user-data-dir=/tmp/arkivo-pc2` (a porta 47800 vai estar ocupada; o envio direto fica desativado e o relay continua).

Testes e verificação de tipos:

```bash
npm test               # tsx --test src/core/*.test.ts
npm run typecheck      # core, main+preload e renderer
```

Os testes das pastas liberadas (`fs-*.test.ts`) criam as pastas em `apps/pc-agent/.fs-test-tmp/` (ignorada pelo git), porque o `os.tmpdir()` fica dentro de pastas que o PC nunca libera (`Users\<x>\AppData` no Windows, `/tmp` e `/var` no Linux/macOS).

Os testes cobrem: HMAC (válido, assinatura errada, hash trocado, timestamp fora da janela, celular de outro usuário, celular fora dos peers), upload LAN de verdade contra o servidor em porta efêmera (completo, retomada por `Content-Range`, conexão caindo no meio, hash errado → 409 com `.part` apagado, sem espaço → 507, nome com `../`), organização por mês no fuso local e colisão de nomes, relay com API falsa (pending, Range após queda, `.part` de execução anterior, hash errado → fail + backoff, 404), durabilidade com espião de fs (ordem escrita → fsync → close → SHA-256 → rename → fsync dos diretórios → report/ack na LAN e no relay; fsync que falha → não conferido; ENOSPC no meio → 507/retomada; `fsyncDir` no Windows e no POSIX; `writeFileAtomic` e `pending-reports.json`), pareamento (WS, polling, renovação, erro), WebSocket (reconexão exponencial), config cifrada e log de atividade, e um teste de integração do agente inteiro. Nas pastas liberadas: raízes (sobreposição, repetida, bloqueadas, limite de 32, interruptor), resolução de caminhos com junction/symlink para dentro e para fora da raiz, bloqueio de credenciais e `.arkivo-*`, fallback NFC/NFD, cada operação contra pasta temporária real (list com cursor e corte do remoto em 180 KiB, stat, thumb com cache e fila cheia, mkdir, rename só de maiúsculas, move com conflito e "pasta para dentro dela mesma", trash sem Lixeira), idempotência entre vias, limites por celular, auditoria (agrupamento de `browse`, 5.000 entradas/90 dias), rotas LAN com assinatura (nonce repetido, query recodificada, corpo trocado, celular fora da lista), download com `Range`/`If-Range`, envio LAN com retomada, buraco, hash errado e conflito `412`, e o RPC remoto com o envelope do shared fazendo o papel do celular, contra uma API falsa de blobs (download em PUTs de 8 MiB com retomada, arquivo que muda → `CHANGED`, envio com queda no meio e retomada por `Range`, `pending` + `fs.event uploadDone`).

## Gerar o instalador

```bash
cd apps/pc-agent
npm run dist:win      # release/Arkivo-para-PC-Setup-<versão>.exe (NSIS, x64), API https://api.arkivo.com
npm run dist:win:teste # o mesmo instalador, mas apontando para a API deste PC (http://localhost:3000)
npm run dist:mac      # .dmg
npm run dist:linux    # .AppImage
```

O endereço da API vem, nesta ordem, de `ARKIVO_API_URL` no ambiente, do `dist/main/build-config.json` gravado por `scripts/write-build-config.mjs` (o `dist:win:teste` grava `http://localhost:3000`) e do padrão (`https://api.arkivo.com` no instalador, `http://localhost:3000` em dev). O instalador de teste e o `npm run dev:pc` usam a mesma pasta de dados (`%APPDATA%\Arkivo para PC`), então o pareamento é compartilhado.

Sem assinatura, o Windows mostra "O Windows protegeu o computador": clique em **Mais informações → Executar assim mesmo**.

> Rodando o `Arkivo.exe` a partir do terminal do VS Code, ele abre como Node e fecha na hora (`bad option`), porque o VS Code define `ELECTRON_RUN_AS_NODE=1` nos processos filhos. Abra pelo atalho ou rode `Remove-Item Env:ELECTRON_RUN_AS_NODE` antes.

O instalador do Windows é NSIS com elevação (`perMachine: true`) porque precisa criar a regra de firewall. Para gerar o `.exe` a partir de Linux/macOS o electron-builder usa Wine; o mais simples é rodar `dist:win` numa máquina Windows ou no CI (`windows-latest`). Assine o executável (`win.signtoolOptions.certificateSubjectName` no electron-builder 26, ou `CSC_LINK`/`CSC_KEY_PASSWORD`) para o SmartScreen não alertar.

> Monorepo: o pacote `@arkivo/shared` é um workspace (link simbólico). Rode `npm run build:shared` antes do build (o script `build` já faz isso). Se o electron-builder não copiar o link, publique o `shared` como dependência de arquivo (`"@arkivo/shared": "file:../../packages/shared"`) ou use `npm install --install-links`.

### Firewall do Windows (porta 47800)

O modo direto exige que o celular alcance `http://<IP-do-PC>:47800`. O instalador inclui [`build/installer.nsh`](./build/installer.nsh), que executa:

```
netsh advfirewall firewall add rule name="Arkivo para PC (LAN 47800)" dir=in action=allow protocol=TCP localport=47800 profile=private program="<pasta>\Arkivo.exe" enable=yes
```

- Só no perfil **Privado** e só para o executável do Arkivo. Se a rede Wi-Fi estiver marcada como **Pública** no Windows, o envio direto não funciona e o celular cai automaticamente no relay. Oriente o usuário a marcar a rede de casa como Privada.
- A desinstalação remove a regra.
- Sem a regra (por exemplo, rodando em dev), o Windows mostra o aviso do firewall na primeira vez que o servidor abre a porta.

## Onde ficam os dados

Diretório de dados do Electron (`app.getPath('userData')`):

| SO | Caminho |
| --- | --- |
| Windows | `%APPDATA%\Arkivo para PC\` |
| macOS | `~/Library/Application Support/Arkivo para PC/` |
| Linux | `~/.config/Arkivo para PC/` |

Arquivos:

- `config.json` — pasta escolhida, autostart, porta, ID do PC, nome da conta, cache dos celulares pareados e os segredos (`deviceToken` e `pairKey`) **cifrados**.
- `activity.json` — últimos 200 eventos (o que aparece em Atividade) e a contagem acumulada por mês.
- `pending-reports.json` — locais de arquivos recebidos pela LAN que ainda não foram reportados à API (sem internet no momento); reenviados ao reconectar e a cada minuto.
- `fs-audit.json` — "O que o celular fez" nas pastas liberadas (últimas 5.000 entradas ou 90 dias). Fica só no PC.
- `fs-uploads.json` — estado dos envios remotos para as pastas liberadas (24 h), para o `uploadStatus` responder mesmo depois de reiniciar o PC.
- `config.json` também guarda as pastas liberadas (`fsRoots`: `{ id, label, absPath, addedAt }`) e o interruptor (`fsEnabled`).

Na pasta escolhida pelo usuário:

- `AAAA/MM/<nome>` — os arquivos, pelo mês de `takenAt` no fuso local do PC.
- `.arkivo-parciais/` — arquivos `.part` em andamento (retomada). São movidos com `rename` para o destino só depois de conferidos; `.part` abandonados há mais de 14 dias são apagados.

Sair da conta ou desconectar o celular **não apaga** nenhum arquivo da pasta.

## Como funciona a segurança

- **Segredos em repouso:** `deviceToken` e `pairKey` são cifrados com `safeStorage` do Electron (DPAPI no Windows, Keychain no macOS, libsecret/kwallet no Linux). Se o SO não tem cofre (Linux sem chaveiro), eles ficam em texto no `config.json` com permissão `600` e a tela de Configurações avisa.
- **API:** toda chamada do PC usa `Authorization: Device <deviceToken>`. O token é entregue uma única vez no pareamento. Se a API responder 401 (PC removido enquanto estava desligado) ou mandar `device.revoked`, o PC apaga as credenciais e volta para o QR.
- **Pareamento:** o QR vale 300 s e uma vez só; é renovado automaticamente ao expirar. O PC espera o resultado por WebSocket anônimo (`pairing` + `pollToken`) ou, se o WS não abrir, por polling a cada 2 s.
- **LAN (modo direto):** cada requisição precisa de `X-Arkivo-Device`, `X-Arkivo-Ts` e `X-Arkivo-Sig = base64(HMAC-SHA256(pairKey, MÉTODO\nCAMINHO\nTS\nSHA256))`. O PC compara com `crypto.timingSafeEqual`, recusa relógio com diferença acima de 120 s e só aceita celulares da lista `GET /v1/devices/pc/peers` (guardada em cache para funcionar sem internet). Só `/v1/ping` é público (devolve apenas o ID do PC e a versão).
- **Integridade:** nada conta como salvo antes de o PC calcular o SHA-256 do arquivo gravado e ele bater com o hash declarado. Hash diferente → `.part` apagado e `409` (LAN) ou `fail` + nova tentativa (relay). Só então o PC reporta o local à API.
- **Durabilidade ("conferido" = está no disco):** como o celular apaga o original depois do "conferido", o PC segue esta ordem nos dois caminhos (LAN e relay), sem exceção:
  1. termina de escrever o `.part`;
  2. `fh.sync()` no `.part` (fsync: dados e tamanho no disco, não só no cache do SO);
  3. fecha o arquivo;
  4. calcula o SHA-256 relendo o arquivo já sincronizado;
  5. `rename` atômico para `AAAA/MM/<nome>`;
  6. fsync do diretório de destino, da pasta `.arkivo-parciais` e dos pais de pastas `AAAA/MM` recém-criadas;
  7. só então responde `200 { verifiedHash }` ao celular, chama `POST /files/:id/locations` ou dá `ack` no relay.

  Na LAN cada pedaço aceito (`202`) também passa por fsync antes da resposta, então o `X-Arkivo-Received` sobrevive a uma queda de energia. O código está em `fs-utils.ts` (`writeStreamDurable`, `fsyncFile`, `fsyncDir`, `mkdirDurable`, `writeFileAtomic`) e é usado por `storage.ts`.
  - **Por que reler para o hash** em vez de calcular durante a escrita: o envio é retomável (pedaços em requisições diferentes, até em execuções diferentes do app), então um hash incremental precisaria guardar estado entre requisições ou reler o prefixo de qualquer jeito. A releitura acontece depois do fsync, então o que é lido é o que foi gravado no disco. Também pega erro de offset ou truncamento no próprio PC. Custo: uma leitura sequencial do arquivo (quase sempre do cache, que depois do fsync é igual ao disco) mais o SHA-256 (~1–2 GB/s com SHA-NI): cerca de 2–4 s num vídeo de 4 GB, pouco perto do tempo de transferência pelo Wi-Fi.
  - **Custo do fsync:** um fsync por pedaço de 8 MiB (SSD: 1–10 ms; HD: 10–30 ms), contra 100–800 ms para transferir esses 8 MiB pelo Wi-Fi, ou seja, 1–5% a mais. Por arquivo, há ainda de 2 a 4 fsyncs de diretório, alguns ms cada. Na prática isso só pesa com milhares de arquivos pequenos (dezenas de ms a mais por arquivo).
  - **Windows:** `fsyncDir` abre o diretório com `'r+'` (o libuv usa `FILE_FLAG_BACKUP_SEMANTICS` com `GENERIC_WRITE`) e chama `FlushFileBuffers`, que no NTFS grava o índice do diretório e o journal. Abrir só para leitura dá `EPERM`. Se o volume não deixar (FAT/exFAT, rede, permissão), vira no-op com um aviso no log: o NTFS já faz journal dos metadados. **POSIX:** `open(dir, 'r')` + `fsync`. No macOS o `fsync` não esvazia o cache interno do disco (`F_FULLFSYNC` não existe no Node). O fsync de diretório **nunca derruba o recebimento**: se falhar, só gera aviso (uma vez por pasta e código de erro).
  - **Falha de disco:** `fsync` do `.part` que falha (qualquer código) → o `.part` é apagado (depois de um fsync que falhou o cache não é confiável) e nada é conferido. `ENOSPC`/`EDQUOT` na escrita ou no fsync → `507` na LAN (com `X-Arkivo-Received`: o início do pedaço quando a escrita falhou, `0` quando o fsync falhou); outros erros de disco → `500`. No relay, erro de disco é falha transitória (contrato §4): sem `ack` e sem `fail`, nova tentativa com backoff. O `.part` fica se a falha foi na escrita (a retomada usa `Range`) e é apagado se foi no fsync.
  - **Arquivos do app** (`config.json`, `pending-reports.json`, `activity.json`): `writeFileAtomic` grava um temporário, faz fsync, fecha, faz `rename` e fsync do diretório. Num corte de energia fica o conteúdo antigo inteiro ou o novo inteiro.
- **Sistema de arquivos:** nomes vindos do celular são sanitizados (sem `../`, sem caminho absoluto, sem `<>:"/\|?*`, sem nomes reservados do Windows, tamanho limitado) e o destino é conferido para nunca sair da pasta escolhida. IDs de arquivo só aceitam `[A-Za-z0-9_-]`.
- **Espaço:** recusa (`507`) quando o espaço livre é menor que o restante do arquivo + 1 GiB.
- **Electron:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP restritiva no renderer (sem rede, sem scripts inline), navegação e novas janelas bloqueadas, permissões negadas, e o processo principal só atende IPC vindo da própria página do app.
- **Pastas liberadas:** rotas `/v1/fs/*` com assinatura própria (`ARKIVO-FS-1`, nonce anti-replay de 240 s, query e corpo assinados), só celulares da lista de pares; nada fora de uma raiz é lido, criado ou apagado (o `realpath` é conferido em toda operação, links para fora são recusados, pastas do sistema e de credenciais são bloqueadas mesmo dentro de uma raiz). Pela internet, pedidos, respostas e conteúdo vão cifrados de ponta a ponta com chaves derivadas do `pairKey` (ressalva honesta no §10.12 do contrato: a API guarda o `pairKey` cifrado).
- **Rede local:** o servidor escuta em `0.0.0.0:47800` com HTTP simples. O conteúdo não sai da rede local e a integridade vem do HMAC + SHA-256; a confidencialidade na LAN depende da rede Wi-Fi (ver `CONTRACT_NOTES.md`).

## Pastas liberadas (contrato §10)

O usuário escolhe, na tela **Pastas liberadas**, pastas de qualquer unidade para o celular ver, baixar, enviar, renomear, mover e apagar (apagar = Lixeira do PC, nunca em definitivo). O interruptor **Acesso pelo celular** começa desligado e liga sozinho ao adicionar a primeira pasta; desligado, toda operação responde `FS_DISABLED`.

**Unidades deste PC [2026-11-06]:** a tela lista as unidades (letra, nome do volume, tipo: Disco interno, Pen drive / HD externo, Unidade de rede, CD/DVD; espaço livre/total; as que não estão prontas ficam de fora), com **Liberar inteira** e **Escolher pasta…** (o seletor abre já na unidade). Marca as unidades liberadas inteiras ("Liberada inteira") e as que têm pastas liberadas ("2 pastas liberadas"), e mostra "Sem Lixeira" em pen drive e rede. A lista é enumerada de novo ao abrir a tela, quando a janela ganha foco e a cada ~10 s com a tela aberta (pen drive conectado aparece sozinho). O renderer manda só o `id` da unidade (a letra); o processo principal enumera de novo, monta o caminho, confere (`RootRegistry.plan`) e, se for unidade inteira, guarda o pedido e devolve um `token` para a confirmação. No macOS/Linux a seção lista os volumes de `/Volumes`, `/media`, `/run/media` e `/mnt`, só com "Escolher pasta…".

**Disco do sistema inteiro [2026-11-06]:** no Windows, `C:\` pode ser liberado inteiro, com um aviso ("O celular vai ver todo o disco C:, menos as pastas do sistema e de programas") e confirmação. Por dentro continuam bloqueados Windows, Program Files, ProgramData, `$Recycle.Bin`, System Volume Information, pagefile/hiberfil/swapfile, AppData, os **perfis de outros usuários** (`C:\Users\<outro>`; `Public` fica liberado), credenciais e os dados do Arkivo (`fsBlockedReason`). Liberar uma unidade que já tem pastas liberadas oferece trocar essas pastas pela unidade inteira (numa gravação só; os envios parciais delas são apagados; no celular elas respondem `ROOT_REMOVED`). Pasta dentro de uma unidade já liberada inteira → "Esta pasta já está liberada: ela fica em …". No macOS e no Linux, `/` continua recusado.

### Peças (`src/core`)

| Arquivo | O que faz |
| --- | --- |
| `fs-roots.ts` | raízes no `config.json`, `id` por `randomFsId()`, recusas do §10.13 (`fsRootRejectReason`, `fsRootsOverlap`, limite 32), `plan` (unidade inteira? troca quais pastas?) e `add` com `replace`, rótulo de unidade (`driveRootLabel`: "Windows (C:)", "Disco local (C:)", "Pen drive (E:)"), `FsSystemContext` com `os.homedir()`, as variáveis do Windows e a pasta de dados do Arkivo em `extraBlocked`; `protectedDirs` (a pasta do backup) e `realpath` injetável (testes) |
| `fs-drives.ts` | "Unidades deste PC": marca a unidade liberada inteira e conta as pastas liberadas em cada uma (`buildDriveViews`); `findDrive` só aceita um `id` da enumeração atual |
| `fs-resolve.ts` | toda resolução de caminho: `realpath` do alvo e da raiz → `isAbsPathInside` + `fsBlockedReason`; `rename`/`move`/`trash` agem no próprio link (`lstat`); fallback NFC/NFD no Linux |
| `fs-service.ts` | despachante único das duas vias (`execute`), idempotência por `(phoneId, requestId)` por 10 min, limites (20 leituras/s, 5 mudanças/s, 4 downloads LAN), `list` com cursor de 60 s e corte para 180 KiB no remoto, `stat`, `thumb`, `mkdir`, `rename`, `move`, `trash` |
| `fs-thumbs.ts` | fila de miniaturas (2 gerando, 32 esperando → `BUSY`) e cache por (realpath, lado, mtime, tamanho) |
| `fs-volume.ts` | Lixeira por volume: Windows via `[System.IO.DriveInfo]` (só `Fixed`), Linux por `/proc/self/mounts`, macOS pelo `mount`; rede e FUSE desconhecido = sem Lixeira; cache de 60 s. `listDrives()` enumera as unidades prontas (`WINDOWS_DRIVES_SCRIPT`, saída em UTF-8; `parseWindowsDrives`, sistema primeiro e depois por letra), sem cache, e renova o tipo usado pela Lixeira |
| `fs-attrs.ts` | atributos oculto/offline do Windows (`cmd /u /c dir /a:h` com a pasta como diretório de trabalho) |
| `fs-lan.ts`, `fs-lan-auth.ts`, `fs-lan-upload.ts` | rotas `/v1/fs/*` (§10.5): assinatura `ARKIVO-FS-1` com query recalculada (`parseFsQuery` + `canonicalFsQuery`), nonce de 240 s e SHA-256 do corpo; download com `Range`/`If-Range`/`ETag`; envio em pedaços em `<raiz>/.arkivo-fs-parciais/<uploadId>.part` + `.json` |
| `fs-place.ts` | regra de conflito do envio (`rename`/`replace`/`fail`), `rename` atômico e fsync dos diretórios |
| `fs-remote.ts` | `fs.request` → `openFsEnvelope` (pares + `FsReplayGuard`) → despachante → `fs.response` cifrado; `fs.event`; download remoto por blob cifrado (responde já, 1ª passada de hash, PUTs de 8 MiB com retomada, `CHANGED` se o arquivo mudar); envio remoto (confere conflito antes, baixa com `Range`, decifra pedaço a pedaço, confere o SHA-256, `DELETE` do blob, `pending` + `fs.event` depois de 15 s) |
| `fs-audit.ts` | `fs-audit.json` (5.000 entradas / 90 dias, navegação agrupada em `browse` a cada 10 min) |
| `fs-platform.ts` | interface do que precisa do Electron (Lixeira e miniaturas); a implementação real é `src/main/fs-electron.ts` |

### Decisões

- **Capacidade `fs`** vai sempre no `/v1/ping`, no `pc.status` e no `PATCH /devices/pc/self`, mesmo com o interruptor desligado ou sem pasta: o §10.5 diz que a capacidade é da build e que o estado vem de `roots`. O celular mostra "nenhuma pasta liberada"/`FS_DISABLED` em vez de "atualize o PC".
- **Sair da conta desliga o interruptor** (logout, "Desconectar", PC removido pelo celular): a lista de pastas fica, mas o próximo pareamento pode ser de outra conta e não herda o acesso.
- **Perfil, dados do Arkivo e backup:** uma pasta que contém o perfil do usuário, a pasta de dados do Arkivo ou a pasta do backup (e a própria pasta do backup) não pode ser movida, renomeada nem apagada pelo celular, porque levaria junto o que é bloqueado ou tiraria o backup do lugar. Com `C:\` inteiro, isso protege `Users`, `Users\<você>` e a pasta do backup; o que está dentro delas continua valendo.
- **Raiz do disco sem permissão de gravar [2026-11-06]:** gravar arquivo direto em `C:\` costuma exigir administrador (criar pasta, não). Antes de receber um envio para a raiz de uma unidade, o PC cria e apaga um arquivo vazio `.arkivo-teste-*`; se o Windows negar, o celular recebe `PERMISSION_DENIED` "O Windows não deixa gravar arquivos direto na raiz do disco. Escolha uma pasta dentro dele." sem gastar banda (e o celular mostra essa mensagem do PC). Renomear ou mover **arquivo** para a raiz e criar pasta nela também respondem `PERMISSION_DENIED` com texto claro, em vez do "feche o arquivo" do `EPERM`. Se nem a pasta oculta de parciais (`C:\.arkivo-fs-parciais`) puder ser criada, o envio falha com o pedido de liberar uma pasta dentro do disco.
- **Lixeira:** antes de cada `trashItem` (e do `replace`) o PC confere o volume; sem Lixeira (pen drive, cartão, rede, FUSE desconhecido) → `TRASH_UNAVAILABLE` e nada é apagado. Na dúvida (comando falhou, unidade desconhecida), recusa.
- **Miniaturas:** Windows/macOS usam `nativeImage.createThumbnailFromPath` (fotos, vídeos e PDF pelas miniaturas do sistema); Linux só PNG/JPEG com `createFromPath` + `resize`. JPEG com qualidade decrescente até caber em 96 KiB. Arquivo do OneDrive "só na nuvem" (atributo offline) fica com `hasThumb: false`, para a miniatura não disparar o download.
- **Durabilidade do envio:** mesma ordem do backup (escrita → fsync → close → SHA-256 relendo → `rename` → fsync dos diretórios) antes de responder `200`/`done`.
- **Limpeza:** na partida, `.part` parado há mais de 7 dias, registros de envios concluídos com mais de 24 h e a pasta `.arkivo-fs-parciais` vazia são apagados. Remover uma raiz apaga os envios parciais dela.
- **Arquivos do app** (`fs-audit.json`, `fs-uploads.json`) usam `writeFileAtomic`, como o `config.json`.

### O que só dá para conferir com o Electron de verdade

`shell.trashItem` (os testes usam uma Lixeira falsa que move o arquivo) e `nativeImage` (os testes usam um gerador falso). A tela (renderer) e o IPC também não têm teste automatizado: rode `npm run dev`, abra **Pastas liberadas**, confira a lista de unidades (conecte um pen drive com a tela aberta), adicione uma pasta de outra unidade, tente `C:\Windows` (recusa), use **Liberar inteira** no `C:` (aviso, confirmação, troca das pastas que já estavam liberadas nele) e confira com o celular que a raiz não mostra Windows, Program Files nem ProgramData e que `Users` só mostra você e `Public`.

O `C:\` real não é liberado em teste automatizado. `tests/integration/fs-drive-e2e.test.ts` simula a unidade do sistema com `subst` (uma letra livre apontando para `.fs-test-tmp/`, montada como um `C:\` de mentira) e injeta `fsEnv` (`%SystemDrive%` etc.) e o `realpath` de JavaScript (`fsRealpath`; o nativo resolve o `subst` para a pasta de verdade), com a raiz sem permissão de gravar arquivo (ACL `WD` negada), nas duas vias.

## Enviar para o celular (contrato §11)

O usuário escolhe arquivos no item **Enviar para o celular** (botão ou arrastar para a janela, em qualquer tela) e o celular mostra "Chegaram 3 arquivos do PC" com **Baixar** e **Recusar**. O arquivo espera **no próprio PC** por até 7 dias, até 200 itens ativos: nada fica guardado a mais no servidor, então o PC precisa estar ligado. Funciona com o interruptor **Acesso pelo celular** desligado e sem nenhuma pasta liberada, porque as operações só levam o `id` de um item, nunca um caminho.

- **`src/core/fs-outbox.ts`:** caixa de saída sem Electron. `outbox.json` com `writeFileAtomic`, estados (§11.4), expiração, limites, bloqueios (pasta, link, `fsBlockedReason`, 2 GiB) e conferência de tamanho e `mtime` a cada entrega (`changed`). Nunca toca no arquivo do usuário.
- **Vias:** o despachante (`fs-service.ts`) atende `outboxList`, `outboxDone` e `outboxDecline` e deixa as operações da caixa de saída fora do interruptor. Na LAN, `fs-lan.ts` serve `/v1/fs/outbox*` com o mesmo código do download. Pela internet, `fs-remote.ts` reaproveita o blob cifrado do download e devolve o mesmo blob se o pedido se repetir.
- **Tela e IPC:** o renderer só entrega os `File` soltos; o preload resolve com `webUtils.getPathForFile` (`File.path` não existe mais) e o processo principal confere tudo de novo, com o padrão `trusted()`.
- **Capacidade:** o PC anuncia `fs-push`. O botão só fica ativo se houver celular com `fs-push` na lista de pares; sem isso, a tela pede para atualizar o app no celular.
- **Sair da conta, desconectar ou ser revogado** apaga a lista. Celular que sai da conta perde os itens dele.
- **Progresso pela internet:** o "Baixando N%" mede o envio do PC ao servidor; o trecho servidor → celular o PC não vê, então fica em 100% até o celular confirmar.

## Comportamento do app

- Instância única: abrir de novo só traz a janela para frente.
- Fechar a janela esconde na bandeja ("Rodando em segundo plano"); para sair, use o menu da bandeja → "Sair do Arkivo".
- Com "Iniciar com o Windows e rodar em segundo plano" ligado, o app abre no login escondido na bandeja (se já estiver pareado).
