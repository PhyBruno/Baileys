# Contrato: avisos de webhook (WSB → receptor)

Compatível com o envelope de webhook da **Evolution API 2.4.0-rc2** (`webhook.controller.ts`). Todos os valores abaixo são sintéticos.

## Requisição

```
POST <url>                       (ou <url>/<evento-kebab> se byEvents = true)
Content-Type: application/json
X-Instance-ID: 5511900000001
X-Instance-Name: 5511900000001
X-Event-Type: messages.upsert
X-Timestamp: 1792750000000
X-Delivery-ID: 4821                 (extra do WSB: estável entre retentativas)
User-Agent: WSB-Webhook/1.0
<cabeçalhos personalizados do webhook>
Authorization: Bearer <jwt>         (só se o webhook tiver o cabeçalho especial jwt_key)
```

**Resposta esperada do receptor**: qualquer `2xx` conta como entregue. `400/401/403/404/422` contam como falha definitiva, sem retentativa, e também `3xx`: redirects não são seguidos, para que os cabeçalhos não vazem para outro destino (decisão da revisão de segurança). Timeout, erro de rede, `408`, `429` e `5xx` levam a nova tentativa com backoff. `qrcode.updated` tem uma tentativa só, porque o QR expira em segundos.

**Semântica**: entrega *at-least-once*. O receptor deve deduplicar por `data.key.id` (+ `instance`) ou por `X-Delivery-ID`.

## Envelope

```json
{
  "event": "messages.upsert",
  "instance": "5511900000001",
  "data": { "...": "ver abaixo" },
  "destination": "https://texteaseai.example/webhooks/wsb",
  "date_time": "2026-10-23T10:15:30.123Z",
  "sender": "5511900000001@s.whatsapp.net",
  "server_url": "https://wsb.example",
  "apikey": null
}
```

| Campo | Regra |
|---|---|
| `event` | minúsculo com ponto: `messages.upsert`, `send.message`, `messages.update`, `messages.edited`, `messages.delete`, `connection.update`, `qrcode.updated` |
| `instance` | id da sessão do WSB (número) |
| `sender` | JID da instância conectada (`null` se ainda não conectou) |
| `server_url` | env `SERVER_URL` ou `null` |
| `apikey` | sempre `null` (o WSB nunca envia a API key global) |

## Eventos de configuração → `event` → sufixo `byEvents`

| Configuração | `event` | Sufixo |
|---|---|---|
| `MESSAGES_UPSERT` | `messages.upsert` | `/messages-upsert` |
| `SEND_MESSAGE` | `send.message` | `/send-message` |
| `MESSAGES_UPDATE` | `messages.update` | `/messages-update` |
| `MESSAGES_EDITED` | `messages.edited` | `/messages-edited` |
| `MESSAGES_DELETE` | `messages.delete` | `/messages-delete` |
| `CONNECTION_UPDATE` | `connection.update` | `/connection-update` |
| `QRCODE_UPDATED` | `qrcode.updated` | `/qrcode-updated` |

## `data` de `messages.upsert` / `send.message`

Formato do `prepareMessage` da Evolution:

```json
{
  "key": {
    "remoteJid": "5511988887777@s.whatsapp.net",
    "remoteJidAlt": "123456789012345@lid",
    "addressingMode": "pn",
    "fromMe": false,
    "id": "3EB0A1B2C3D4E5F60718"
  },
  "pushName": "Maria Exemplo",
  "status": "DELIVERY_ACK",
  "message": { "conversation": "Olá, tudo bem?" },
  "contextInfo": null,
  "messageType": "conversation",
  "messageTimestamp": 1792750000,
  "instanceId": "5511900000001",
  "source": "android"
}
```

Em grupo (instância com `groups_ignore = false`), `key.remoteJid` é `<id>@g.us` e `key.participant` traz o autor.

### Exemplos de `message` / `messageType` por tipo

| Tipo | `messageType` | `message` (resumo) |
|---|---|---|
| Texto (inclusive com link/citação) | `conversation` | `{ "conversation": "texto" }`; citação em `contextInfo.quotedMessage` + `contextInfo.stanzaId` |
| Imagem | `imageMessage` | `{ "imageMessage": { "url", "mimetype": "image/jpeg", "caption", "fileLength", "height", "width", "mediaKey": "<b64>", "directPath", "jpegThumbnail": "<b64>" }, "base64": "<b64>?" }` |
| Áudio / voz | `audioMessage` | `{ "audioMessage": { "mimetype": "audio/ogg; codecs=opus", "seconds": 7, "ptt": true, ... }, "base64"? }` |
| Vídeo / vídeo-nota | `videoMessage` / `ptvMessage` | idem, com `seconds`, `caption` |
| Documento (com ou sem legenda) | `documentMessage` | `{ "documentMessage": { "fileName": "boleto.pdf", "mimetype": "application/pdf", "caption"?, ... }, "base64"? }` |
| Sticker | `stickerMessage` | `{ "stickerMessage": { "mimetype": "image/webp", "isAnimated": false, ... }, "base64"? }` |
| Localização | `locationMessage` | `{ "locationMessage": { "degreesLatitude": -23.5, "degreesLongitude": -46.6, "name"?, "address"? } }` |
| Contato(s) | `contactMessage` / `contactsArrayMessage` | `{ "contactMessage": { "displayName", "vcard" } }` |
| Reação | `reactionMessage` | `{ "reactionMessage": { "key": { "remoteJid", "fromMe": true, "id": "<msg reagida>" }, "text": "👍", "senderTimestampMs": "..." } }`; `text: ""` = reação removida |
| Resposta de lista | `listResponseMessage` | `{ "listResponseMessage": { "title": "Opção 2", "listType": 1, "singleSelectReply": { "selectedRowId": "opt-2" }, "contextInfo": { "stanzaId": "<id da lista>" } } }` |
| Resposta de botão (antigo) | `buttonsResponseMessage` | `{ "buttonsResponseMessage": { "selectedButtonId": "btn-1", "selectedDisplayText": "Sim" } }` |
| Resposta de botão de modelo | `templateButtonReplyMessage` | `{ "templateButtonReplyMessage": { "selectedId": "btn-1", "selectedDisplayText": "Sim" } }` |
| Resposta de botão interativo (native flow, enviado por `sendButtons`) | `interactiveResponseMessage` | `{ "interactiveResponseMessage": { "body": { "text": "Sim" }, "nativeFlowResponseMessage": { "name": "quick_reply", "paramsJson": "{\"id\":\"btn-1\"}" } } }` |
| Voto em enquete | `pollUpdateMessage` | cru, sem decriptar (research R2) |
| Outros | tipo original do Baileys | conteúdo cru normalizado |

### Mídia (`base64`)

- Só presente se o webhook tem `base64: true` e a mensagem é imagem/vídeo/ptv/áudio/documento/sticker.
- `message.base64`: arquivo inteiro em base64 (sem prefixo `data:`).
- Se não foi possível embutir: `message.base64Error` = `"too_large"` (acima de `WEBHOOK_MEDIA_MAX_BYTES`) ou `"download_failed"`. Nesse caso o arquivo pode ser pedido em `POST /sessions/:id/chat/getBase64FromMediaMessage` (ver rest-api.md).

### Divergências intencionais em relação à Evolution

1. Campos binários (`mediaKey`, `fileSha256`, `fileEncSha256`, `jpegThumbnail`, `messageSecret` etc.) saem como **string base64**. A Evolution os serializa como objeto indexado (`{"0":12,"1":34}`). Pelo mesmo motivo, números `Long` do protobuf (`fileLength`, `mediaKeyTimestamp`) saem como número. Além disso, `contextInfo` vem `null` quando não existe, enquanto na Evolution o campo some do JSON.
2. `apikey` é sempre `null`.
3. `message.base64Error` é um campo extra do WSB.
4. Endereçamento LID: mesma troca da Evolution (`remoteJid` = PN, `remoteJidAlt` = LID, `addressingMode: "pn"`), mas em mensagens `fromMe` um alt que aponte para o próprio número é descartado (a Evolution trocaria pelo número da instância), e o PN também é buscado no mapeamento LID→PN do Baileys quando não vem na mensagem. Sem PN conhecido, chega `remoteJid: "...@lid"` com `addressingMode: "lid"`. Em grupo, a regra vale para `participant`/`participantAlt`. Ver research R2.1.
5. `messages.upsert` não inclui por padrão mensagens enviadas pelo próprio número (só com `includeFromMe`), e **nunca** inclui as enviadas pela API do WSB, que saem só como `send.message`. Isso evita eco/loop em integrações como Chatwoot.

## `data` dos demais eventos (formato da Evolution)

**`messages.update`**

```json
{ "messageId": "4821", "keyId": "3EB0A1B2C3D4E5F60718", "remoteJid": "5511988887777@s.whatsapp.net",
  "fromMe": true, "participant": null, "status": "READ", "instanceId": "5511900000001" }
```

`messageId` é o id interno de `wa_messages`, como string.

**`messages.edited`**: o `protocolMessage` de edição normalizado (`{ "key": {...}, "type": "MESSAGE_EDIT", "editedMessage": { "conversation": "texto novo" } }`).

**`messages.delete`**: a `key` da mensagem apagada (`{ "remoteJid", "fromMe", "id" }`).

**`connection.update`**

```json
{ "instance": "5511900000001", "wuid": "5511900000001@s.whatsapp.net", "profileName": "Loja Exemplo",
  "state": "open", "statusReason": 200 }
```

`state`: `open | connecting | close`. `statusReason`: código de desconexão do Baileys quando houver.

**`qrcode.updated`**

```json
{ "qrcode": { "instance": "5511900000001", "pairingCode": null, "code": "2@abc...", "base64": "data:image/png;base64,..." } }
```

## Evento de teste

`POST /sessions/:id/webhooks/:webhookId/test` envia `event: "webhook.test"` com `data: { "message": "Teste de webhook do WSB", "webhookId": "<uuid>" }`. Vai direto, sem outbox nem retentativa, e o resultado volta na resposta da API.
