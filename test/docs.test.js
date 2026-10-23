import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// docs/contracts/ é a cópia publicada (dentro deste repositório) dos
// contratos da feature, cuja fonte é ../specs/001-inbound-messages-webhooks/
// — pasta do Spec Kit que fica FORA do repositório git do baileys. Quando
// ela existe ao lado (ambiente de desenvolvimento), as duas versões precisam
// ser iguais; num clone só do repositório, o teste é pulado.
const SPECS = new URL('../../specs/001-inbound-messages-webhooks/contracts/', import.meta.url)
const DOCS = new URL('../docs/contracts/', import.meta.url)
const skip = fs.existsSync(SPECS) ? false : 'specs/ não está ao lado deste repositório'

for (const file of ['webhook-payload.md', 'rest-api.md']) {
  test(`docs/contracts/${file} está igual ao contrato do specs/`, { skip }, () => {
    const normalize = (text) => text.replace(/\r\n/g, '\n')
    const source = normalize(fs.readFileSync(new URL(file, SPECS), 'utf-8'))
    const published = normalize(fs.readFileSync(new URL(file, DOCS), 'utf-8'))
    assert.ok(
      source === published,
      `docs/contracts/${file} divergiu de specs/: copie de novo ` +
        '(cp ../specs/001-inbound-messages-webhooks/contracts/*.md docs/contracts/)'
    )
  })
}

test('docs/contracts publicados existem', () => {
  for (const file of ['webhook-payload.md', 'rest-api.md']) assert.ok(fs.existsSync(new URL(file, DOCS)), file)
})
