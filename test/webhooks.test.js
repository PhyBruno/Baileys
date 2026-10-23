import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WEBHOOK_EVENTS, HEADER_MASK, validateWebhookInput, maskHeaders, mergeHeaders, selectTargets } from '../webhooks.js'

const ok = (body) => {
  const result = validateWebhookInput(body)
  assert.equal(result.error, undefined, result.error)
  return result.value
}
const fails = (body, pattern) => {
  const result = validateWebhookInput(body)
  assert.ok(result.error, 'deveria falhar')
  if (pattern) assert.match(result.error, pattern)
}

// ---------------- (a) validateWebhookInput ----------------

test('aplica os defaults quando só a url vem', () => {
  assert.deepEqual(ok({ url: 'https://texteaseai.example/webhooks/wsb' }), {
    url: 'https://texteaseai.example/webhooks/wsb',
    enabled: true,
    events: ['MESSAGES_UPSERT'],
    base64: false,
    byEvents: false,
    includeFromMe: false,
    headers: {}
  })
})

test('url precisa ser http(s) válida e com até 2048 caracteres', () => {
  fails({}, /url/)
  fails({ url: 'ftp://exemplo.com/x' }, /http/)
  fails({ url: 'javascript:alert(1)' }, /http/)
  fails({ url: 'não é url' }, /url/)
  fails({ url: 'https://exemplo.com/' + 'a'.repeat(2048) }, /2048/)
  ok({ url: 'http://texteaseai:8080/hook?token=1' })
})

test('events: vazio vira MESSAGES_UPSERT, desconhecido é rejeitado, repetido é unificado', () => {
  assert.deepEqual(ok({ url: 'https://x.example', events: [] }).events, ['MESSAGES_UPSERT'])
  assert.deepEqual(ok({ url: 'https://x.example', events: ['SEND_MESSAGE', 'SEND_MESSAGE'] }).events, ['SEND_MESSAGE'])
  assert.deepEqual(ok({ url: 'https://x.example', events: WEBHOOK_EVENTS }).events, WEBHOOK_EVENTS)
  fails({ url: 'https://x.example', events: ['MESSAGES_SET'] }, /MESSAGES_SET/)
  fails({ url: 'https://x.example', events: 'MESSAGES_UPSERT' }, /array/)
})

test('booleanos precisam ser booleanos', () => {
  for (const field of ['enabled', 'base64', 'byEvents', 'includeFromMe']) {
    fails({ url: 'https://x.example', [field]: 'true' }, new RegExp(field))
  }
  const value = ok({ url: 'https://x.example', enabled: false, base64: true, byEvents: true, includeFromMe: true })
  assert.deepEqual([value.enabled, value.base64, value.byEvents, value.includeFromMe], [false, true, true, true])
})

test('headers: objeto string → string, até 20 chaves, nomes válidos', () => {
  assert.deepEqual(ok({ url: 'https://x.example', headers: { Authorization: 'Bearer xyz', jwt_key: 'segredo' } }).headers, {
    Authorization: 'Bearer xyz',
    jwt_key: 'segredo'
  })
  fails({ url: 'https://x.example', headers: ['a'] }, /headers/)
  fails({ url: 'https://x.example', headers: 'Authorization: x' }, /headers/)
  fails({ url: 'https://x.example', headers: { Authorization: 123 } }, /Authorization/)
  fails({ url: 'https://x.example', headers: { 'Nome Inválido': 'x' } }, /Nome Inválido/)
  fails({ url: 'https://x.example', headers: { 'X-Quebra': 'a\r\nb' } }, /X-Quebra/)
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, 'v']))
  fails({ url: 'https://x.example', headers: many }, /20/)
})

test('headers: tamanho, cabeçalhos reservados e caracteres que o fetch não aceita', () => {
  fails({ url: 'https://x.example', headers: { 'X-Grande': 'a'.repeat(8193) } }, /8192/)
  fails({ url: 'https://x.example', headers: { ['X-' + 'n'.repeat(300)]: 'v' } }, /inválido/)
  fails({ url: 'https://x.example', headers: { Host: 'interno' } }, /Host/)
  fails({ url: 'https://x.example', headers: { 'Content-Length': '1' } }, /Content-Length/)
  fails({ url: 'https://x.example', headers: { 'X-Emoji': 'ok 👍' } }, /X-Emoji/)
  ok({ url: 'https://x.example', headers: { 'X-Latin': 'São Paulo', Authorization: HEADER_MASK } })
})

test('url com usuário/senha é rejeitada (credencial vai em headers)', () => {
  fails({ url: 'https://user:senha@x.example/hook' }, /usuário\/senha/)
})

test('corpo que não é objeto é rejeitado', () => {
  fails(null)
  fails('url=https://x.example')
})

// ---------------- (b) maskHeaders / mergeHeaders ----------------

test('maskHeaders troca todos os valores pela máscara', () => {
  assert.deepEqual(maskHeaders({ Authorization: 'Bearer xyz', jwt_key: 's' }), { Authorization: HEADER_MASK, jwt_key: HEADER_MASK })
  assert.deepEqual(maskHeaders({}), {})
  assert.deepEqual(maskHeaders(null), {})
})

test('mergeHeaders mantém o valor salvo quando chega a máscara', () => {
  const saved = { Authorization: 'Bearer antigo', 'X-Outro': 'mantido' }
  assert.deepEqual(mergeHeaders({ Authorization: HEADER_MASK, 'X-Novo': 'novo' }, saved), {
    Authorization: 'Bearer antigo',
    'X-Novo': 'novo'
  })
  assert.deepEqual(mergeHeaders({ Authorization: 'Bearer trocado' }, saved), { Authorization: 'Bearer trocado' })
  assert.deepEqual(mergeHeaders({ 'X-Sem-Valor': HEADER_MASK }, saved), {}, 'máscara sem valor salvo é descartada')
})

// ---------------- (c) selectTargets ----------------

const hooks = [
  { id: 'a', enabled: true, events: ['MESSAGES_UPSERT'], includeFromMe: false },
  { id: 'b', enabled: true, events: ['MESSAGES_UPSERT', 'SEND_MESSAGE'], includeFromMe: true },
  { id: 'c', enabled: false, events: ['MESSAGES_UPSERT', 'SEND_MESSAGE'], includeFromMe: true },
  { id: 'd', enabled: true, events: ['CONNECTION_UPDATE'], includeFromMe: false }
]
const ids = (list) => list.map((w) => w.id)

test('selectTargets: inbound vai pra todos os ativos inscritos', () => {
  assert.deepEqual(ids(selectTargets(hooks, 'MESSAGES_UPSERT', 'inbound')), ['a', 'b'])
})

test('selectTargets: device só vai pra quem tem includeFromMe', () => {
  assert.deepEqual(ids(selectTargets(hooks, 'MESSAGES_UPSERT', 'device')), ['b'])
})

test('selectTargets: api nunca sai como MESSAGES_UPSERT', () => {
  assert.deepEqual(ids(selectTargets(hooks, 'MESSAGES_UPSERT', 'api')), [])
  assert.deepEqual(ids(selectTargets(hooks, 'SEND_MESSAGE', 'api')), ['b'])
})

test('selectTargets: eventos sem mensagem ignoram origin, inativos ficam de fora', () => {
  assert.deepEqual(ids(selectTargets(hooks, 'CONNECTION_UPDATE')), ['d'])
  assert.deepEqual(ids(selectTargets(hooks, 'QRCODE_UPDATED')), [])
})
