# Amostras de webhook da Evolution API 2.4.0-rc2

Os campos binários (`mediaKey`, `fileSha256`, `fileEncSha256`, `jpegThumbnail`, `messageSecret` etc.) foram trocados por string base64, e os números `Long` (`fileLength`, `mediaKeyTimestamp`) por número. A Evolution entrega os binários como objeto indexado (`{"0":12,"1":34,...}`), e essa troca é a divergência 1 de `docs/contracts/webhook-payload.md`.

Os valores são sintéticos. A estrutura segue o envelope de `webhook.controller.ts` (`event`, `instance`, `data`, `destination`, `date_time`, `sender`, `server_url`, `apikey`) e o `data` do `prepareMessage` (`key`, `pushName`, `status`, `message`, `contextInfo`, `messageType`, `messageTimestamp`, `instanceId`, `source`).

Quando a mensagem não tem `contextInfo`, a Evolution omite o campo (`undefined` some do JSON), enquanto o WSB manda `null`. O teste de contrato (`test/webhookDispatcher.test.js`) trata os dois casos como equivalentes.

Essas amostras são a referência do teste de contrato (SC-005). Para cada uma, o teste gera o envelope do WSB a partir do fixture equivalente em `../messages/` e compara chaves e tipos.
