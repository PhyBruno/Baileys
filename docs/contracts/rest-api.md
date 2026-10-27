# Contrato: API REST nova (WSB)

Todas as rotas ficam sob `/sessions` e herdam o middleware existente de `x-api-key` (`401 { "error": "API key ausente ou inválida..." }`). O `:id` é o número da sessão, normalizado com `normalizeNumber`. Erros seguem o padrão atual: `{ "error": "<mensagem em português>" }`. Sessão inexistente em `wa_sessions` → `404`.

Valores sintéticos.

---

## Configurações da instância

### `GET /sessions/:id/settings`

`200 { "groupsIgnore": true }`

### `PATCH /sessions/:id/settings`

Body: `{ "groupsIgnore": false }`. `groupsIgnore` precisa ser booleano, senão `400`.
`200 { "groupsIgnore": false }`. Vale imediatamente para as próximas mensagens (atualiza o `entry` em memória se a sessão estiver viva).

---

## Webhooks

Representação (`Webhook`):

```json
{
  "id": "6f1c2d3e-0000-4000-8000-000000000001",
  "url": "https://texteaseai.example/webhooks/wsb",
  "enabled": true,
  "events": ["MESSAGES_UPSERT"],
  "base64": true,
  "byEvents": false,
  "includeFromMe": false,
  "headers": { "Authorization": "••••" },
  "createdAt": "2026-10-23T10:00:00.000Z",
  "updatedAt": "2026-10-23T10:00:00.000Z",
  "lastDelivery": { "status": "delivered", "statusCode": 200, "at": "2026-10-23T10:15:30.000Z" }
}
```

`headers` vem sempre mascarado na leitura. `lastDelivery` é `null` se nunca houve entrega.

### `GET /sessions/:id/webhooks`

`200 Webhook[]`

### `POST /sessions/:id/webhooks`

Body (só `url` é obrigatório):

```json
{ "url": "https://...", "enabled": true, "events": ["MESSAGES_UPSERT"], "base64": false,
  "byEvents": false, "includeFromMe": false, "headers": { "Authorization": "Bearer xyz" } }
```

Validação, com `400` e mensagem específica em cada caso:

- `url` precisa ser URL válida com protocolo `http:`/`https:` e no máximo 2048 chars.
- `events` precisa ser array de valores conhecidos (lista em webhook-payload.md); vazio ou ausente vira `["MESSAGES_UPSERT"]`.
- `url` não pode ter usuário/senha (credencial vai em `headers`).
- `headers` precisa ser um objeto plano `string → string`, com no máximo 20 chaves e nomes de header válidos (até 256 caracteres). Os valores vão até 8192 caracteres, só ASCII/Latin-1. `Host`, `Content-Length`, `Transfer-Encoding` e `Connection` são recusados.
- Booleanos precisam ser booleanos.
- Limite de 10 webhooks por instância.

`201 Webhook`

### `PUT /sessions/:id/webhooks/:webhookId`

Body: mesmo formato, substituição completa. Valor de header igual a `"••••"` mantém o valor salvo, desde que a origem da URL (esquema + host + porta) não mude. Se mudar e algum header vier com a máscara, a resposta é `400` pedindo o valor de novo.
`200 Webhook` · `404` se o webhook não existir ou não pertencer à sessão.

### `DELETE /sessions/:id/webhooks/:webhookId`

`200 { "id": "...", "status": "removed" }`. As entregas pendentes são descartadas (CASCADE). `404` se não existir.

### `POST /sessions/:id/webhooks/:webhookId/test`

Envia o evento `webhook.test` na hora, sem outbox, com o mesmo timeout.
`200 { "ok": true, "statusCode": 200, "durationMs": 184 }` ou `200 { "ok": false, "statusCode": 500, "durationMs": 95, "error": "HTTP 500" }` / `{ "ok": false, "statusCode": null, "error": "timeout após 10000ms" }`.
A resposta é sempre `200` quando o teste rodou: o resultado do destino vai no corpo.

### `GET /sessions/:id/webhooks/:webhookId/deliveries?status=&limit=50&before=`

- `status` opcional: `pending|delivering|delivered|failed`
- `limit`: 1–200, padrão 50
- `before`: id de paginação

`200`:

```json
{ "items": [ { "id": 4821, "event": "MESSAGES_UPSERT", "status": "failed", "attempts": 10,
  "lastStatusCode": 503, "lastError": "HTTP 503", "nextAttemptAt": null,
  "createdAt": "...", "deliveredAt": null, "messageKeyId": "3EB0A1B2C3D4E5F60718" } ],
  "nextBefore": 4790 }
```

O payload não é devolvido aqui, para manter a resposta leve.

---

## Mensagens

### `GET /sessions/:id/messages?remoteJid=&limit=50&before=`

Histórico gravado, do mais novo para o mais antigo. `remoteJid` é opcional (dígitos ou JID). `limit` vai de 1 a 200.
`200 { "items": [ <data no formato de messages.upsert> + "origin" (+ "groupSubject" em item de grupo) ], "nextBefore": <id|null> }`

Item de grupo (`key.remoteJid` terminando em `@g.us`) traz também **`groupSubject`** (`string | null`), o nome do grupo; item individual não tem o campo. Regras:

- É o nome **atual** do grupo, resolvido na leitura, e não o que ele tinha quando a mensagem foi enviada. O nome não é gravado em `wa_messages` (sem backfill); só o mapeamento JID → nome fica em `wa_groups`.
- Cada grupo distinto da página é resolvido uma vez (memória → uma consulta a `wa_groups` pra página inteira → consulta ao WhatsApp só pros que faltaram). Com `remoteJid=<grupo>`, é uma resolução só.
- Consultas ao WhatsApp por requisição: no máximo `GROUP_METADATA_HISTORY_MAX_LOOKUPS` (padrão 10), dentro de um orçamento total de `GROUP_METADATA_HISTORY_BUDGET_MS` (padrão 5000 ms). O que passar do limite, falhar ou demorar sai com `groupSubject: null`, e a resposta continua `200`.
- Com a sessão desconectada, o nome vem só da memória e de `wa_groups` (grupos já vistos); os demais saem `null`.
- Paginação (`limit`, `before`, `nextBefore`) e ordem não mudam.

`contextInfo.participantAlt` e `contextInfo.mentionedJidAlt[]` (citação e menções com LID trocado por telefone) seguem as regras de webhook-payload.md e saem iguais aqui, nas mensagens gravadas a partir desta versão.

### `POST /sessions/:id/chat/getBase64FromMediaMessage`

Compatível com a rota homônima da Evolution (`/chat/getBase64FromMediaMessage/:instance`).

Body: `{ "message": { "key": { "id": "3EB0A1B2C3D4E5F60718" } }, "convertToMp4": false }`. Também aceita a mensagem inteira (`message.message`), no formato da Evolution, com `mediaKey` em base64 ou como objeto indexado. `convertToMp4` é aceito e ignorado: não há ffmpeg na imagem.

`200`:

```json
{ "mediaType": "imageMessage", "fileName": "3EB0A1B2C3D4E5F60718.jpeg", "caption": "foto",
  "size": { "fileLength": 48213, "height": 1280, "width": 720 }, "mimetype": "image/jpeg",
  "base64": "<b64>" }
```

Erros:

- `404`: mensagem não encontrada nesta sessão
- `400`: a mensagem não é de mídia
- `409`: sessão não conectada (precisa do socket para reupload)
- `413`: mídia acima de `WEBHOOK_MEDIA_MAX_BYTES` (acrescentado na implementação, para não carregar arquivos arbitrariamente grandes em memória)
- `502`: o WhatsApp não devolveu a mídia (expirada/indisponível ou timeout)

---

## Manager (estáticos)

`GET /manager` e qualquer subcaminho servem a SPA, **sem** API key. Os arquivos não contêm dados, e toda chamada da SPA usa as rotas acima com `x-api-key`. `GET /manager` → `index.html`, com fallback de SPA para rotas desconhecidas sob `/manager`. No Express 5 o fallback é declarado como `/manager/{*splat}`, porque `'/manager/*'` é inválido.

## Mudanças em rotas existentes

- `POST /sessions/:id/messages`, `/message/sendList` e `/message/sendButtons`:
  - Geram o id da mensagem antes de enviar e o registram como "enviado pela API" (research R4).
  - Depois do envio, gravam em `wa_messages` com `origin = 'api'` e enfileiram `SEND_MESSAGE`.
  - O formato da resposta HTTP não muda. A espera de status começa **antes** da gravação, que roda em paralelo a ela, então a gravação não atrasa a resposta nem faz perder confirmações (SC-007).
- `POST /sessions/:id/messages` — destino de grupo e `type: "audio"` (mudança aditiva; texto, imagem, documento, vídeo e destino em dígitos não mudam):
  - `to` aceita, além de dígitos com DDI, o JID de grupo no formato `^[0-9]+(-[0-9]+)?@g\.us$` (ex.: `120363000000000001@g.us` ou `5511999999999-1600000000@g.us`). Grupo **não** passa por `onWhatsApp`; a participação é conferida antes do envio pelo `groupMetadata` (lista em memória que o Baileys usa no envio, senão `sock.groupMetadata(jid)`). Falha da consulta ou número da sessão fora dos participantes (comparando PN e LID da sessão com `id`, `lid` e `phoneNumber` de cada participante) → `404 { "error": "grupo não encontrado ou o número não participa" }`. O envio segue o mesmo fluxo do individual (id gerado antes, registro como "enviado pela API", `wa_messages`, `SEND_MESSAGE` e espera de status).
  - `to` aceita também o JID de usuário, com ou sem sufixo de dispositivo `:N` (descartado): `^\d{8,15}@s\.whatsapp\.net$` segue como os dígitos (resolvido pelo `onWhatsApp`, `404` se não registrado); `^[0-9]+(:[0-9]+)?@lid$` vai direto ao LID, sem `onWhatsApp` (o Baileys não aceita LID nele).
  - Qualquer outro JID em `to` (`@newsletter`, `@broadcast`, `@c.us` etc.) → `400` (`formato de "to" inválido...`). Antes, esses JIDs tinham o sufixo descartado pela normalização de dígitos e podiam seguir como número.
  - `type` aceita `"text" | "image" | "video" | "document" | "audio"`; fora disso, `400 { "error": "campo \"type\" inválido. Use \"text\" (default), \"image\", \"video\", \"document\" ou \"audio\"." }`.
  - `type: "audio"`: `mediaBase64` (base64 puro ou data URL, obrigatório), `mimetype` (obrigatório; voz: `audio/ogg; codecs=opus`) e `ptt` (opcional, padrão `false`; só o booleano `true` envia como mensagem de voz). Conteúdo do Baileys: `{ audio: <Buffer>, mimetype, ptt }`. Sem `mimetype` → `400 { "error": "informe \"mimetype\" (obrigatório quando \"type\" é \"audio\")" }`; `mediaBase64` ausente ou inválido → os mesmos `400` das demais mídias.
  - `/message/sendList` e `/message/sendButtons` continuam recusando grupo e `@lid` em `number`.
- `DELETE /sessions/:id`: sem mudança de código. O CASCADE remove mensagens, webhooks e entregas.
- `GET /sessions`: sem mudança (a tela usa o retorno atual).
