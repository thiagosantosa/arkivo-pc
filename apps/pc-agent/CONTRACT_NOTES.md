# Notas sobre o contrato (lado do PC)

Pontos do `docs/CONTRACT.md` que continuam abertos para o receptor do PC. Os itens resolvidos na revisão de integração de 2026-11-03 (assinatura LAN, respostas de pedaço, CORS, relay com nova tentativa, close codes do WS, `email` no pareamento, link copiável do pareamento etc.) foram incorporados ao contrato e removidos daqui. Os itens marcados **[proposta]** são sugestões para a próxima revisão.

## LAN

1. **Replay.** O HMAC não cobre o corpo nem o `Content-Range`. Dentro da janela de 120 s, alguém na mesma rede pode reenviar uma requisição capturada. Isso não permite gravar conteúdo falso (o SHA-256 final é conferido contra o hash assinado), mas permite estragar um `.part` em andamento (o arquivo termina em `409` e é reenviado). **[proposta]** incluir `Content-Range` e um nonce no texto assinado numa v2.
2. **Confidencialidade na LAN.** O conteúdo trafega em HTTP simples na rede local (como o contrato define). Em Wi-Fi aberto/compartilhado, quem estiver na rede pode ler os arquivos. **[proposta]** cifrar o corpo com chave derivada da `pairKey` ou usar TLS com certificado fixado no pareamento.

## Durabilidade de "conferido" (LAN e relay)

O contrato diz que só vale como salvo o que o PC conferiu pelo SHA-256 (§1, §4, §6). O PC entende "conferido" como **gravado de forma durável e com o hash batendo**: escrita → `fh.sync()` no `.part` → close → SHA-256 relendo o arquivo → `rename` atômico → fsync do diretório de destino e da pasta de parciais (e dos pais de `AAAA/MM` novas). Só depois disso vêm o `200 { verifiedHash }` da LAN, o `POST /files/:id/locations` e o `ack` do relay. Detalhes, custo e comportamento no Windows estão no README (Durabilidade).

- **LAN, `202` por pedaço:** cada pedaço aceito também passa por fsync antes do `202`, então o `X-Arkivo-Received` do `HEAD` continua valendo depois de uma queda de energia.
- **LAN, `507` durante a escrita ou o fsync:** a §6 só cita o `507` da checagem antes de gravar. O PC também responde `507 QUOTA_EXCEEDED` quando o disco enche no meio (`ENOSPC`/`EDQUOT`) e põe `X-Arkivo-Received`: o início do pedaço se a escrita falhou (o `.part` volta para lá) ou `0` se o fsync falhou (o `.part` é apagado porque o cache não é confiável depois de um fsync que falhou). Outros erros de disco → `500 INTERNAL`. O corpo é descartado sem derrubar o socket, para o celular receber a resposta. **[proposta]** registrar isso na §6.
- **Relay, erro de disco:** segue a §4 (falha transitória do PC): sem `ack` e **sem `fail`**, nova tentativa com backoff. O `.part` fica se a falha foi na escrita (retoma com `Range`) e é apagado se foi no fsync.
- **Windows:** o fsync de diretório usa `FlushFileBuffers` num handle do diretório aberto com `'r+'`; se o volume recusar, vira no-op com aviso (o NTFS faz journal dos metadados). Falha de fsync de **diretório** nunca impede o recebimento; falha de fsync do **arquivo** sempre impede o "conferido".
- **`pending-reports.json` e `config.json`:** gravados com tmp → fsync → rename → fsync do diretório. Se não der para gravar o relatório pendente (API fora e disco cheio), a LAN responde `507`/`500` em vez de `200`: o arquivo fica no PC e o celular reenvia (cai no "mesmo nome e mesmo hash").

## Desconectar / sair da conta

3. **"Desconectar" o celular na tela do PC** não tem rota própria no contrato (o pareamento é PC ↔ conta, não PC ↔ celular). O PC usa `POST /v1/devices/pc/logout` nos dois botões ("Desconectar" e "Sair da conta neste PC"); só muda o aviso mostrado na tela do QR, com os textos do protótipo. **[proposta]** decidir se "Desconectar" deve remover só aquele celular (`DELETE /devices/:phoneId` acessível ao PC).
4. **Logout sem internet:** o PC apaga as credenciais localmente mesmo se `POST /v1/devices/pc/logout` falhar. O PC continua listado na conta até o celular removê-lo (`DELETE /v1/devices/:id`).
5. **`device.revoked`** ou qualquer `401` da API → o PC apaga as credenciais, para os serviços e volta ao QR com o aviso "Este PC foi desconectado da sua conta pelo celular. Escaneie de novo para voltar a receber backups." (texto novo, o protótipo não tem esse caso).

## `PATCH /v1/devices/pc/self` e `pc.status`

6. `folderLabel` = caminho completo da pasta escolhida (é o que o app do celular mostra no design, ex.: `C:\Users\Thiago\Pictures\Arkivo`).
7. `freeBytes` = espaço livre no volume da pasta escolhida (`fs.statfs`, `bavail × bsize`).

## Versão (§9)

8. **WebSocket sem cabeçalho.** O `WsFactory` só recebe a URL; por isso o PC manda `client`/`protocol` na query do WS (a API aceita os dois jeitos), sem mexer no adaptador de `src/main`.
9. **`updateRequired` desliga também a LAN.** Mesmo que o protocolo LAN ainda fosse compatível com o celular, o PC recusado pela API para tudo: o objetivo do mínimo é forçar a atualização. Credenciais, pasta e histórico ficam. **[proposta]** botão "Baixar atualização" quando houver canal de atualização automática (electron-updater) ou URL oficial de download.
10. **426 do servidor LAN** traz `minVersion: null` (o PC não tem mínimo de celular, só faixa de protocolo).

## Pastas liberadas (§10) [2026-11-04]

Interpretações do PC onde o contrato não é explícito. Os itens **[proposta]** são lacunas para a próxima revisão do contrato/shared.

11. **Capacidade `fs` sempre anunciada** (ping, `pc.status`, `PATCH pc/self`), mesmo com o interruptor desligado ou sem nenhuma pasta. Segue o §10.5 ("mesmo com o interruptor desligado; o estado vem de `roots`"); assim o celular distingue "PC sem o recurso" (atualize) de "acesso desligado" (`FS_DISABLED`).
12. **Interruptor:** começa desligado; adicionar a **primeira** pasta liga sozinho (§10.1 "desligado até o usuário adicionar a primeira pasta"). Depois disso só o usuário muda.
13. **`upload` remoto — erros de pré-checagem** (`CONFLICT`, `TRASH_UNAVAILABLE` no `replace`, `NO_SPACE`, `TOO_LARGE`, `RATE_LIMITED`, caminho/raiz) voltam como `FsRpcResult { ok: false }`, antes de baixar qualquer byte. Erros **durante** o trabalho (download do blob, `HASH_MISMATCH`, disco) voltam como `FsUploadStatusResponse { status: 'failed', error }` (na resposta ou no `uploadStatus`/`fs.event uploadFailed`).
14. **`upload` remoto — idempotência:** o mesmo `requestId` devolve o estado atual do envio daquele `blobId` (inclusive `pending`), sem baixar de novo. Um `upload` com **outro** `requestId` e o mesmo `blobId` só recomeça se o envio anterior falhou (ex.: `NO_SPACE`, §10.7 passo 4).
15. **`HASH_MISMATCH` no envio remoto:** o PC apaga o `.part` e dá `DELETE` no blob (o conteúdo não serve; devolve a cota). `NO_SPACE` e falha de rede mantêm blob e `.part` (o celular repete depois). Conflito no final mantém o blob até o TTL (o celular pode repetir com outra política).
16. **Erros da API ao criar blob** (download remoto): `413` → `TOO_LARGE`, `429` → `RATE_LIMITED`, `507` → `BUSY` ("A fila temporária do servidor está cheia"), rede → `INTERNAL`. **[proposta]** o shared não exporta `FS_BLOB_MAX_BYTES`; o PC usa 2 GiB (o padrão de `RELAY_MAX_FILE_BYTES`) e confia no `413` da API para limites menores.
17. **Envio LAN ocupado** (mesmo `uploadId` em outra conexão) → `423` com código **`BUSY`** (§10.3 lista "mesmo envio em outra conexão" em `BUSY`), e não `CONFLICT` como no §4.1 do backup. O celular trata `423` igual nos dois casos.
18. **`HEAD /v1/fs/upload/:id` de envio já concluído** devolve `X-Arkivo-Received` = tamanho total; pela regra do §4.1 o celular reenvia o último pedaço e recebe o mesmo `FsUploadResult` (`200`). O registro de concluído fica no `<uploadId>.json` por 24 h (sobrevive a reiniciar o PC).
19. **`replace` sobre uma pasta** (já existe uma pasta com o nome do arquivo) → `CONFLICT`: o PC não manda pastas inteiras para a Lixeira sem o usuário pedir.
20. **Limites sem número no contrato:** download LAN conta como leitura (20/s) além do teto de 4 simultâneos; `download` remoto (preparo de blob) conta como mudança (5/s) e tem teto de 4 em preparo por celular; no máximo 16 RPCs executando ao mesmo tempo no PC (acima → `fs.response { error: BUSY }`).
21. **Idempotência não guarda erros passageiros** (`BUSY`, `RATE_LIMITED`, `INTERNAL`, `ROOT_UNAVAILABLE`, `FS_DISABLED`, `NO_SPACE`): repetir pode dar certo. Os demais erros e todos os sucessos ficam guardados 10 min.
22. **Rotas LAN com método errado** → `405` com código `VALIDATION_ERROR` (o `FS_ERROR_STATUS` não tem um código para isso).
23. **Anti-replay do envelope** (`REPLAYED`) e qualquer outra falha de abertura que não seja horário saem como `E2E_FAILED`; horário fora da janela (`EXPIRED`) sai como `CLOCK_SKEW`.
24. **`EPERM` no Windows** em operações de escrita vira `BUSY` ("Feche o arquivo no PC"), porque quase sempre é arquivo aberto em outro programa (§10.11); em leitura vira `PERMISSION_DENIED`.
25. **Oculto e "somente online" no Windows:** o Node não expõe atributos, então o PC usa `cmd /u /c dir /a:h` e `dir /a:o` na pasta listada (saída UTF-16, sem caminho na linha de comando). O `stat` avulso usa só a regra do nome (`.` no começo), para não abrir um processo por item. `RECALL_ON_DATA_ACCESS` não aparece no `dir`; o atributo offline cobre os casos comuns do OneDrive. **[proposta]** módulo nativo opcional para ler os atributos direto.
26. **Auditoria:** o download pela LAN entra uma vez por download (o pedido que começa no byte 0); retomadas com `Range` não geram entradas novas. Em `move`/`trash` o `count` é o número de itens que deram certo (ou o total, se todos falharam, com o código do primeiro erro em `result`).
27. **Pedaços do envio LAN e o limite de 5 mudanças/s:** só o pedaço que começa no byte 0 conta como mudança; os seguintes usam a cota de leitura (20/s). Contar todos seguraria o envio em 40 MiB/s.
28. **Sair da conta desliga o interruptor** (logout, "Desconectar" e `device.revoked`). A lista de pastas fica, mas o próximo pareamento pode ser de outra conta e não herda o acesso sem o usuário ligar de novo. O contrato não trata desse caso. **[proposta]** registrar no §10.1.
29. **Pasta que contém o perfil do usuário ou os dados do Arkivo** (`Users\ana` numa raiz `C:\Users`) não pode ser movida, renomeada nem apagada (`FORBIDDEN_PATH`): `rename`/`move`/`trash` levam junto o que está dentro, inclusive o que é bloqueado. Outras pastas que só *contêm* algo bloqueado (ex.: uma subpasta `.ssh`) continuam podendo ser movidas e mandadas para a Lixeira. **[proposta]** decidir no §10.2 se vale recusar também esse caso; exigiria percorrer a árvore antes de cada operação.
30. **Testes e pastas bloqueadas:** como `os.tmpdir()` é bloqueado nas três plataformas (`AppData`, `/tmp`, `/var`), os testes usam `apps/pc-agent/.fs-test-tmp/`. Consequência para o produto: o usuário não consegue liberar pastas dentro de `AppData` nem de `/tmp`, como manda o §10.2.
