# WhatsApp Bridge API (Baileys + Postgres)

Aplicação pequena e "burra" de propósito: só conecta, reconecta, desconecta e
dispara mensagem por múltiplos números de WhatsApp. Toda a lógica de negócio
fica na sua aplicação principal, que chama esta bridge por HTTP.

Cada número é uma sessão, identificada pelo próprio número. As credenciais
(sessão do WhatsApp Web) ficam persistidas no **Postgres**, não em arquivo —
então dá pra rodar em containers efêmeros, escalar horizontalmente lendo do
mesmo banco (com cuidado: cada sessão só pode estar "viva" em um processo por
vez), e restaurar tudo sozinho quando o processo reinicia.

## Formato do número (ID da sessão e destinatário)

**Só dígitos, com DDI, sem `+`, espaço, parênteses ou traço.**

```
5511999999999
│└┤└─────────┴─ número
│ └─ DDD
└─ DDI (Brasil = 55)
```

A API normaliza automaticamente o que vier com máscara (`(11) 99999-9999` vira
`11999999999`), mas o ID da sessão precisa bater com 8 a 15 dígitos depois de
normalizado — senão ela recusa com 400.

## Setup

### 1. Banco de dados

```bash
createdb whatsapp_bridge
```

As tabelas (`wa_sessions`, `wa_auth_state`) são criadas automaticamente na
primeira vez que o servidor sobe (roda `schema.sql` via `CREATE TABLE IF NOT
EXISTS`).

### 2. Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste:

```
DATABASE_URL=postgres://usuario:senha@localhost:5432/whatsapp_bridge
PORT=3000
API_KEY=troque-por-uma-chave-forte      # obrigatória, o servidor não sobe sem ela
RECONNECT_MAX_ATTEMPTS=5                # tentativas de reconexão automática após queda
RECONNECT_DELAY_MS=30000                # espera fixa entre cada tentativa (30s)
```

### 3. Instalar e rodar

```bash
npm install
node server.js
```

## Rodando com Docker

```bash
cp .env.example .env   # ajuste API_KEY e POSTGRES_PASSWORD
docker compose up -d --build
```

Isso sobe dois containers: `postgres` (com volume nomeado `pgdata`, então os
dados sobrevivem a `docker compose down`) e `bridge` (builda a partir do
`Dockerfile` local, só espera o Postgres passar no healthcheck antes de
subir). A bridge fica exposta em `http://localhost:3000` (ou o que você
definir em `PORT` no `.env`).

Rodando fora do compose (seu próprio Postgres, outro orquestrador etc.), o
`Dockerfile` sozinho também funciona:

```bash
docker build -t whatsapp-bridge .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/whatsapp_bridge \
  -e API_KEY=troque-por-uma-chave-forte \
  whatsapp-bridge
```

A imagem é baseada em `node:22-slim` (não alpine): o Baileys puxa o `sharp`
como dependência transitiva, e resolver o binário pré-compilado certo é mais
previsível em glibc do que em musl. Não precisa de toolchain de build — nem
Python, nem gcc. O container roda como usuário não-root e não escreve nada em
disco (todo o estado vive no Postgres), então não precisa de volume na
bridge em si.

> Não tive como testar o build de verdade neste ambiente (sem Docker e sem
> acesso à registry aqui), então revise o build no seu ambiente antes de
> confiar cegamente — mas validei a parte que mais costuma quebrar (a
> dependência nativa) e a sintaxe do `docker-compose.yml`.

## Autenticação

Toda rota sob `/sessions` exige uma API key global, enviada no header
`x-api-key`. Sem ela (ou com valor errado), a resposta é `401`. É a mesma
chave pra todos os endpoints — pensada pra ser usada pela sua aplicação
principal, não por múltiplos clientes com permissões diferentes.

`GET /health` fica fora da autenticação, pra load balancer/orquestrador
checar se o processo está de pé sem precisar da chave.

## Endpoints

Todos abaixo (exceto `/health`) exigem `x-api-key` no header.

| Método | Rota                        | O que faz                                                                 |
|--------|------------------------------|-----------------------------------------------------------------------------|
| GET    | `/health`                    | Liveness check, sem autenticação.                                          |
| POST   | `/sessions/:id/connect`      | Conecta/reconecta o número `:id`. Cria sessão nova se não existir.         |
| GET    | `/sessions/:id/qr`           | QR code (base64 PNG) pra parear, ou status atual se já conectado.          |
| GET    | `/sessions`                  | Lista todas as sessões (persistidas no banco) e seus status.               |
| POST   | `/sessions/:id/disconnect`   | Fecha a conexão mas **mantém** as credenciais — reconecta sem novo QR.     |
| DELETE | `/sessions/:id`              | Logout definitivo: invalida no WhatsApp e apaga as credenciais do banco.   |
| POST   | `/sessions/:id/messages`     | Dispara mensagem: `{ "to": "5511988887777", "message": "oi" }`             |

### Exemplo de uso

```bash
KEY="troque-por-uma-chave-forte"

# 1. inicia o pareamento do número
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/connect

# 2. pega o QR e escaneia no celular (Aparelhos conectados → Conectar aparelho)
curl -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/qr

# 3. dispara mensagem por esse número
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/messages \
  -H "Content-Type: application/json" \
  -d '{"to": "5511988887777", "message": "Olá!"}'

# 4. desconecta sem perder a sessão (dá pra reconectar depois sem novo QR,
#    e NÃO aciona reconexão automática — foi um pedido manual)
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/disconnect

# 5. reconecta usando a credencial salva
curl -X POST -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999/connect

# 6. logout definitivo (precisa escanear QR de novo pra usar esse número)
curl -X DELETE -H "x-api-key: $KEY" http://localhost:3000/sessions/5511999999999
```

## Status possíveis de uma sessão

`connecting` → `qr` (aguardando escaneamento) → `connected`
`connected` → `disconnected` (via `/disconnect`, credenciais mantidas, **sem** reconexão automática)
`connected`/`qr` → `reconnecting` (queda de rede — não solicitada — tenta sozinho)
`reconnecting` → `error` (desistiu após `RECONNECT_MAX_ATTEMPTS` tentativas — chame `/connect` de novo)
qualquer → `logged_out` (deslogado pelo próprio WhatsApp ou via `DELETE`, credenciais apagadas)

## Decisões de design (e o que falta pra produção séria)

- **Reconexão automática só em queda não solicitada**, com quantidade de
  tentativas e delay fixo entre elas configuráveis via `RECONNECT_MAX_ATTEMPTS`
  e `RECONNECT_DELAY_MS`. Uma desconexão pedida via `/disconnect` ou `DELETE`
  nunca acorda reconexão sozinha — só volta se você chamar `/connect`.
- **Usa os utilitários oficiais do Baileys sempre que possível**, em vez de
  reimplementar: `makeCacheableSignalKeyStore` (cache em memória sobre as
  chaves de sessão, reduz leitura no Postgres — é o padrão recomendado pela
  própria lib) e `Browsers.ubuntu(...)` pro identificador de dispositivo. Se o
  formato que o WhatsApp espera mudar, resolve com `npm update baileys`, sem
  mexer no nosso código.
- **`unhandledRejection`/`uncaughtException` são logados, não derrubam o
  processo.** Baileys mexe com WebSocket cru e criptografia de sinal e
  ocasionalmente algum erro escapa dos handlers normais; preferimos manter as
  outras sessões de pé.
- **A API key é única e global** — não distingue quem está chamando. Se
  precisar de múltiplos consumidores com permissões diferentes, isso pede uma
  camada de auth mais completa (uma key por cliente, JWT, etc.).
- **Um processo = um dono de cada sessão.** Se você rodar múltiplas réplicas
  da bridge apontando pro mesmo Postgres, cada sessão só deve ser "conectada"
  em uma réplica por vez (senão as duas brigam pelo mesmo socket do
  WhatsApp). Pra escalar de verdade, seria preciso um lock distribuído (ex:
  `pg_advisory_lock` por `session_id`) decidindo quem "possui" cada sessão.
- **Sem fila de envio** — disparos são síncronos, um por chamada. Se for
  disparar volume, vale enfileirar (ex: BullMQ/Redis) com um intervalo entre
  mensagens pra não levar ban.

## Avisos importantes

- **Baileys não é oficial** — reimplementa o protocolo do WhatsApp Web. Uma
  mudança da Meta pode quebrar a lib até os mantenedores atualizarem.
- **Risco de banimento**: números usados para disparo em massa, spam ou fora
  dos termos de uso do WhatsApp podem ser banidos. Use para comunicação
  legítima com destinatários que esperam a mensagem.

## Revisão de código (feita manualmente — sem subagent/segundo modelo disponível neste ambiente)

### Revisão contra a documentação oficial do Baileys (baileys.wiki)

- **`restartRequired` (515) agora reconecta na hora, sem contar como
  tentativa falha.** Esse código de desconexão é disparado pelo próprio
  WhatsApp logo após você escanear o QR — é parte normal do pareamento, não
  um erro. A doc é explícita: "Reconnect immediately". Antes, nosso código
  tratava isso como qualquer outra queda e esperava `RECONNECT_DELAY_MS`
  (30s por padrão) antes de reconectar, o que deixava o fluxo de parear um
  número novo lento e podia até gastar tentativas do orçamento de reconexão
  à toa.
- **Adicionado `getMessage` ao socket.** A documentação trata `auth`,
  `logger` e `getMessage` como as três opções praticamente obrigatórias do
  `makeWASocket` — sem `getMessage`, o WhatsApp não consegue pedir reenvio
  de uma mensagem quando falha em decriptar do lado de quem recebe (o
  sintoma conhecido é a mensagem ficar travada em "this message can take a
  while"). Implementei com um cache em memória, limitado a 100 mensagens por
  sessão — cobre o caso de retry logo após o envio sem precisar de uma
  tabela nova no Postgres nem virar um histórico de mensagens de verdade.
- **Removido `printQRInTerminal: false`** — está marcado como deprecated na
  doc atual. Já escutávamos o campo `qr` direto no `connection.update`
  (que é o jeito recomendado), então a opção não fazia nada além de usar uma
  API obsoleta.
- **Confirmado que `fetchLatestBaileysVersion()` é o padrão certo** (não é a
  função arriscada que a doc pede pra evitar — essa é `fetchLatestWaWebVersion`,
  que a gente não usa) e que ela já degrada graciosamente pra versão padrão
  do pacote se a rede falhar. Bate com todo exemplo oficial e da comunidade
  que encontrei, incluindo implementações de auth state customizado.
- **Confirmado que a abordagem de auth state em Postgres é exatamente a
  recomendada**: a própria doc/README do Baileys diz que `useMultiFileAuthState`
  "serves as a good guide to help write auth & key states for SQL/no-SQL
  databases, which I would recommend in any production grade system" — e a
  FAQ chega a desaconselhar `useMultiFileAuthState` em produção pelo I/O de
  disco. Nosso `postgresAuthState.js` segue essa recomendação à risca.

### Achados anteriores (revisão de código geral)

Achados corrigidos:

- **Race condition no startup**: o servidor podia aceitar requisições HTTP
  antes de `migrate()` criar as tabelas. Corrigido: `migrate()` agora roda
  (e é esperado) antes do `app.listen()`, e uma falha aí derruba o processo
  com mensagem clara em vez de silenciosamente deixar a app num estado
  quebrado.
- **`RECONNECT_MAX_ATTEMPTS`/`RECONNECT_DELAY_MS` inválidos viravam `NaN`**,
  o que desativava silenciosamente o limite de tentativas (`attempt > NaN` é
  sempre falso) — voltando ao loop apertado de reconexão que a gente tinha
  corrigido antes. Agora valida no boot e recusa subir se vier algo inválido.
- **Duas chamadas concorrentes de `/connect` pro mesmo número** podiam criar
  dois sockets Baileys ao mesmo tempo escrevendo na mesma linha de
  credenciais no Postgres. Adicionado um lock em memória por sessão
  (`startSessionSerialized`) que faz a segunda chamada esperar a primeira em
  vez de duplicar.
- **Comparação da API key não era timing-safe** (`!==` numa string vaza
  timing). Trocada por `crypto.timingSafeEqual`.
- **`package-lock.json` não estava nos arquivos entregues** — o Dockerfile
  usa `npm ci`, que exige esse arquivo. Corrigido.
- **Sem suporte a SSL no Postgres** — a maioria dos provedores gerenciados
  exige. Adicionado `DATABASE_SSL=true` como opção.

Limitações conhecidas que **não** foram resolvidas agora (escopo/trade-off,
não bug):

- **Só manda mensagem pra contato individual**, não pra grupo (`@g.us`) ou
  canal — a validação de número rejeitaria o formato de JID de grupo. Se
  precisar disso, dá pra adicionar sem muita dificuldade.
- **`restartRequired` é tratado à parte (reconecta na hora); os demais
  motivos de queda que não são "logged out" recebem o mesmo tratamento**
  (retry com delay fixo). A doc também documenta `badSession`,
  `forbidden` e `multideviceMismatch` como casos que **retry sozinho
  provavelmente não resolve** (sessão corrompida, credencial rejeitada,
  versão desatualizada) — hoje eles caem no mesmo caminho genérico de
  retry-até-desistir. Funciona (eventualmente desiste e pede `/connect`
  manual), só não é o mais rápido possível pra esses casos específicos.
- **A API key é única e global**, sem granularidade por cliente.

## Revisão de código — rodada 2 (Claude Code, com Docker/Postgres reais e o pacote baileys instalado)

Feita num ambiente com Docker, Node 22 e Postgres reais disponíveis (a
diferença real em relação à rodada anterior, que rodou só no chat do
claude.ai). Ainda **sem número de WhatsApp de teste disponível**, então o
pareamento real (QR → `connection: 'open'`) e o envio de mensagem real
continuam **não testados de ponta a ponta** — essa é a lacuna que mais
importa resolver antes de confiar cegamente nisso em produção.

### O que rodou de verdade aqui

- **`npm install` / `npm ci --omit=dev`**: ambos passam limpos com o
  `package-lock.json` entregue — confirma que o Dockerfile builda a etapa de
  instalação de dependências sem surpresas.
- **`npm audit`**: **0 vulnerabilidades** em 208 dependências (177 prod + 28
  optional + peer).
- **`baileys@^7.0.0-rc14` é a versão mais atual publicada** (`npm view
  baileys dist-tags` → `latest: 7.0.0-rc14`). Não há nada mais novo pra
  atualizar agora.
- **`server.js` rodou de verdade contra um Postgres real** (não o chat, um
  Postgres instalado neste ambiente): migração automática, todos os
  endpoints (401/200, validação de formato, `/connect` → `/disconnect` →
  restart do processo → `/connect` de novo), incluindo os dois bugs
  encontrados e corrigidos abaixo — reproduzidos e confirmados corrigidos,
  não só deduzidos lendo o código.
- **`docker compose up --build` NÃO rodou de ponta a ponta.** O Docker
  Engine deste ambiente péde daemon rodando manualmente, e uma vez rodando,
  tanto `postgres:16-alpine` quanto `node:22-slim` falham o pull com `403
  Forbidden` — a política de rede deste ambiente bloqueia o registry do
  Docker Hub (confirmado como bloqueio de política, não falha transitória:
  o endpoint de status do proxy interno reporta `connect_rejected` /
  "policy denial" pro host do CDN do Docker Hub). Isso não é algo pra
  contornar — é uma limitação real deste ambiente de revisão, igual à falta
  de acesso aos servidores do WhatsApp. **O build Docker continua não
  validado de ponta a ponta**; o que dava pra confirmar sem pull de imagem
  (sintaxe do `docker-compose.yml`, `npm ci` isolado, resolução do binário
  nativo do `sharp` — que instalou normalmente tanto a variante glibc quanto
  a musl como dependência transitiva do baileys) segue OK.

### Revisão contra o código-fonte instalado do baileys (não só a doc)

Com o pacote `baileys@7.0.0-rc14` de verdade instalado em `node_modules`,
deu pra confirmar direto no código (não só confiar na wiki, que muda de
versão pra versão) que:

- `DisconnectReason.restartRequired = 515` e o próprio baileys trata esse
  código como caso especial internamente (loga como "restart required", não
  como erro) — o fix da rodada anterior está alinhado com o que a lib
  realmente faz, não só com o que a doc diz.
- **O baileys 7 já tem um cache de retry de mensagens embutido, ligado por
  padrão.** Existe uma opção `enableRecentMessageCache` (default `true` em
  `Defaults/index.js`) que liga um `MessageRetryManager` interno — um LRU de
  até 512 mensagens com TTL de 5 minutos — e o fluxo de retry
  (`sendMessagesAgain` em `messages-recv.js`) consulta esse cache **antes**
  de cair no `getMessage` que a aplicação fornece. Ou seja: o `getMessage`
  customizado deste projeto (cache de 100 mensagens, sem TTL, por sessão)
  não é mais "praticamente obrigatório" do jeito que a rodada anterior
  descreveu — isso era verdade em versões/docs mais antigas do baileys, mas
  na 7.0.0-rc14 ele só entra em ação pra um retry que chegue depois da
  janela de 5 minutos/512 mensagens do cache interno da própria lib. Não é
  incorreto manter (é uma rede de segurança adicional, sem custo real), só
  não tem mais o peso de "sem isso, mensagem trava" que a doc mais antiga
  sugeria — deixei um comentário no código explicando isso.
- `postgresAuthState.js` é, linha a linha, a mesma lógica de
  `useMultiFileAuthState` (lib/Utils/use-multi-file-auth-state.js do
  próprio pacote): mesmo formato de chave (`creds` / `<tipo>-<id>`), mesmo
  tratamento especial de `app-state-sync-key` via
  `proto.Message.AppStateSyncKeyData.fromObject`, mesmo uso de
  `BufferJSON`/`initAuthCreds`. Confirma que o auth state customizado está
  correto pra essa versão do baileys, não só "parecido com a doc".
- `fetchLatestBaileysVersion()`, `makeCacheableSignalKeyStore`,
  `Browsers.ubuntu(...)` e todos os outros imports nomeados de `'baileys'`
  usados no projeto existem e resolvem normalmente no pacote instalado —
  nada ficou órfão de uma renomeação de API entre versões.
- **Default que vale a pena conhecer**: `syncFullHistory: true` é o default
  do `makeWASocket` (`DEFAULT_CONNECTION_CONFIG` em `Defaults/index.js`).
  Essa bridge não lê chat nem histórico — só dispara mensagem — então
  baixar e decriptar o histórico completo de conversas a cada pareamento
  novo (o que esse default faz) é tempo e banda gastos à toa, sem nenhum
  consumidor pro resultado. Corrigido: `syncFullHistory: false` explícito
  no socket.

### Bugs/race conditions novos, encontrados e corrigidos nesta rodada

- **Timer de reconexão órfão podia criar dois sockets vivos pra mesma
  sessão.** O `setTimeout` de reconexão automática (`RECONNECT_DELAY_MS`)
  nunca era cancelado. Sequência que reproduz o problema: a conexão cai →
  agenda reconexão em 30s → antes desse prazo, alguém chama `/connect`
  manualmente (ou o fluxo de `restartRequired` reconecta na hora) e a
  sessão volta a ficar `connected` → o timer de 30s, que ninguém cancelou,
  dispara mesmo assim e cria **mais um** socket do baileys por cima do que
  já estava funcionando — dois sockets vivos ao mesmo tempo com a mesma
  credencial. Na prática isso tende a fazer o WhatsApp derrubar um dos dois
  com `connectionReplaced` (440), e como esse motivo cai no caminho
  genérico de retry, pode virar um ciclo de reconexão desnecessário.
  Corrigido guardando o handle do `setTimeout` por sessão
  (`reconnectTimers`) e cancelando-o em todo ponto que inicia uma sessão de
  novo (início de `startSession`) ou que a encerra de propósito
  (`/disconnect`, `DELETE`, `logged_out`, desistência após
  `RECONNECT_MAX_ATTEMPTS`).
- **Reiniciar o processo religava sessões que tinham sido desconectadas de
  propósito via `/disconnect`.** `restorePersistedSessions()` reconectava
  toda sessão com status diferente de `logged_out` — incluindo
  `disconnected`. Isso quebra a garantia documentada de que "`/disconnect`
  nunca aciona reconexão automática sozinha": bastava um redeploy, crash ou
  reagendamento pelo orquestrador pra religar sozinho uma sessão que o
  operador tinha desligado de propósito. Corrigido excluindo `disconnected`
  também do filtro de restauração no boot. (Também corrigido, no mesmo
  espírito: pedir `/disconnect` para uma sessão que já estava na janela de
  espera de `reconnecting` não cancelava o timer pendente — o socket antigo
  já estava fechado, então chamar `.end()` nele de novo era um no-op que não
  disparava o `connection.update` que cancelaria a reconexão. Agora
  `/disconnect` cancela o timer diretamente, sem depender desse evento.)
- **`fetchLatestBaileysVersion()` rodava em todo `/connect`, toda
  reconexão automática e uma vez por sessão restaurada no boot** — uma
  chamada HTTP ao GitHub repetida sem necessidade (a versão não muda em
  runtime) e sem timeout algum (a função não aceita `AbortSignal`; se a
  chamada travar sem nunca resolver — plausível num deploy com egress
  restrito a só os domínios do WhatsApp — `startSession()` travava
  indefinidamente junto). Corrigido: a versão é resolvida uma única vez no
  boot, com um timeout próprio de 8s (`Promise.race`), e reaproveitada em
  toda chamada de `startSession()`; se o timeout estourar, segue com a
  versão embutida no pacote instalado.

- **`.gitignore` não excluía `.env`** — só o `.dockerignore` excluía (o que
  protege o build da imagem, mas não protege o repositório git). Um
  `git add -A`/`git add .` descuidado neste projeto commitava a
  `API_KEY`/`POSTGRES_PASSWORD`/`DATABASE_URL` reais direto no histórico.
  Corrigido: `.env`, `.env.*` (com exceção do `.env.example`) adicionados ao
  `.gitignore`, espelhando o que o `.dockerignore` já fazia.

### Ainda não verificado (limitação deste ambiente, não deste código)

- Pareamento real via QR code contra os servidores do WhatsApp.
- Envio de mensagem real e um cenário real de retry (pra validar o
  `getMessage` customizado e o cache interno do baileys 7 na prática, não
  só lendo o código-fonte).
- `docker compose up --build` de ponta a ponta (bloqueado pela política de
  rede deste ambiente pro registry do Docker Hub, não pelo projeto).
