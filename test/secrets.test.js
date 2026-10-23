import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHeaderCipher, HeaderDecryptError } from '../secrets.js'

const cipher = createHeaderCipher('segredo-de-teste')

test('cifra os valores e mantém os nomes legíveis', () => {
  const encrypted = cipher.encryptHeaders({ Authorization: 'Bearer token-do-receptor', jwt_key: 'k' })
  assert.deepEqual(Object.keys(encrypted), ['Authorization', 'jwt_key'])
  for (const value of Object.values(encrypted)) assert.match(value, /^enc:v1:/)
  assert.equal(JSON.stringify(encrypted).includes('token-do-receptor'), false)
  assert.deepEqual(cipher.decryptHeaders(encrypted), { Authorization: 'Bearer token-do-receptor', jwt_key: 'k' })
})

test('IV aleatório: o mesmo valor gera cifras diferentes', () => {
  const a = cipher.encryptHeaders({ X: 'mesmo' }).X
  const b = cipher.encryptHeaders({ X: 'mesmo' }).X
  assert.notEqual(a, b)
})

test('valor já cifrado não é cifrado de novo', () => {
  const once = cipher.encryptHeaders({ X: 'v' })
  assert.deepEqual(cipher.encryptHeaders(once), once)
})

test('texto puro legado passa direto na decifração e é detectado', () => {
  assert.deepEqual(cipher.decryptHeaders({ X: 'antigo' }), { X: 'antigo' })
  assert.equal(cipher.hasPlaintext({ X: 'antigo' }), true)
  assert.equal(cipher.hasPlaintext(cipher.encryptHeaders({ X: 'antigo' })), false)
  assert.equal(cipher.hasPlaintext({}), false)
})

test('outra chave não decifra (HeaderDecryptError com o nome do cabeçalho)', () => {
  const encrypted = cipher.encryptHeaders({ Authorization: 'Bearer x' })
  assert.throws(() => createHeaderCipher('outra-chave').decryptHeaders(encrypted), (err) => {
    assert.ok(err instanceof HeaderDecryptError)
    assert.equal(err.header, 'Authorization')
    assert.equal(err.message.includes('Bearer x'), false)
    return true
  })
})

test('valor adulterado ou movido para outro cabeçalho não decifra', () => {
  const { A } = cipher.encryptHeaders({ A: 'valor de A' })
  const raw = Buffer.from(A.slice('enc:v1:'.length), 'base64')
  raw[raw.length - 1] ^= 1
  assert.throws(() => cipher.decryptHeaders({ A: 'enc:v1:' + raw.toString('base64') }), HeaderDecryptError)
  assert.throws(() => cipher.decryptHeaders({ B: A }), HeaderDecryptError, 'AAD amarra o valor ao nome')
})

test('segredo vazio é recusado', () => {
  assert.throws(() => createHeaderCipher(''))
})
