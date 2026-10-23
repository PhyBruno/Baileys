import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Teste de integração do outbox (T019): precisa de um Postgres de teste.
//   TEST_DATABASE_URL=postgres://user:senha@localhost:5432/wsb_test npm test
// Sem a variável, todos os casos são pulados. O db.js lê DATABASE_URL no
// import, então ela é trocada ANTES do import dinâmico dos módulos.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = TEST_DATABASE_URL ? false : 'defina TEST_DATABASE_URL para rodar o teste de integração do outbox'

const SESSION = '5511900000099'
const config = {
  timeoutMs: 2000,
  concurrency: 10,
  concurrencyPerWebhook: 10,
  pollIntervalMs: 1000,
  retryMaxAttempts: 15,
  retryInitialDelayMs: 5000,
  retryMaxDelayMs: 300_000,
  mediaTimeoutMs: 1000,
  retentionDays: 7,
  serverUrl: null
}

let db, store, webhooksModule, dispatcherModule, secretsModule, cipher, server, serverUrl
let responder = () => 200
const hits = []

const sample = (id) => ({
  key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id, addressingMode: 'pn' },
  pushName: 'Maria Exemplo',
  status: 'DELIVERY_ACK',
  message: { conversation: `mensagem ${id}` },
  contextInfo: null,
  messageType: 'conversation',
  messageTimestamp: 1792750000,
  instanceId: SESSION,
  source: 'android'
})

before(async () => {
  if (skip) return
  process.env.DATABASE_URL = TEST_DATABASE_URL
  db = await import('../../db.js')
  store = await import('../../messageStore.js')
  webhooksModule = await import('../../webhooks.js')
  dispatcherModule = await import('../../webhookDispatcher.js')
  secretsModule = await import('../../secrets.js')
  cipher = secretsModule.createHeaderCipher('chave-de-teste-do-outbox')
  await db.migrate()

  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      hits.push({
        url: req.url,
        deliveryId: req.headers['x-delivery-id'],
        event: req.headers['x-event-type'],
        teste: req.headers['x-teste'],
        body: JSON.parse(body)
      })
      const respond = () => {
        res.statusCode = responder(req)
        res.end('ok')
      }
      // Receptor "lento": segura a resposta pra ocupar a vaga do webhook.
      if (req.url.startsWith('/lento')) setTimeout(respond, 300)
      else respond()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${server.address().port}/hook`
})

after(async () => {
  if (skip) return
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  await db.pool.end()
  await new Promise((resolve) => server.close(resolve))
})

let service
beforeEach(async () => {
  if (skip) return
  hits.length = 0
  responder = () => 200
  // Sessão limpa a cada caso: o CASCADE leva mensagens, webhooks e entregas.
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  await db.pool.query(`INSERT INTO wa_sessions (id, status, jid) VALUES ($1, 'connected', $2)`, [SESSION, `${SESSION}:3@s.whatsapp.net`])
  service = webhooksModule.createWebhookService({ pool: db.pool, cipher })
  await service.createWebhook(SESSION, {
    url: serverUrl,
    enabled: true,
    events: ['MESSAGES_UPSERT'],
    base64: false,
    byEvents: false,
    includeFromMe: false,
    headers: { 'X-Teste': 'sim' }
  })
})

const enqueueUpsert = (client, row) =>
  service.enqueue(client, SESSION, 'MESSAGES_UPSERT', store.webhookDataFromRow(row), { messageId: row.id, origin: row.origin })

const deliveries = async () =>
  (await db.pool.query('SELECT * FROM wa_webhook_deliveries WHERE session_id = $1 ORDER BY id', [SESSION])).rows

const dispatcher = ({ cipher: otherCipher, ...overrides } = {}) =>
  dispatcherModule.createDispatcher({ pool: db.pool, cipher: otherCipher ?? cipher, config: { ...config, ...overrides } })

test('(a) saveMessage duplicado não gera segunda linha nem segunda entrega', { skip }, async () => {
  const data = sample('DUP1')
  const first = await store.saveMessage(SESSION, data, 'inbound', { onInserted: enqueueUpsert })
  const second = await store.saveMessage(SESSION, data, 'inbound', { onInserted: enqueueUpsert })
  assert.ok(first)
  assert.equal(second, null)
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM wa_messages WHERE session_id = $1', [SESSION])
  assert.equal(rows[0].n, 1)
  assert.equal((await deliveries()).length, 1)
})

test('(b) a entrega nasce na mesma transação: rollback não deixa entrega órfã', { skip }, async () => {
  await assert.rejects(
    store.saveMessage(SESSION, sample('RB1'), 'inbound', {
      onInserted: async (client, row) => {
        await enqueueUpsert(client, row)
        throw new Error('falha simulada depois do enqueue')
      }
    })
  )
  assert.equal((await deliveries()).length, 0)
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM wa_messages WHERE session_id = $1', [SESSION])
  assert.equal(rows[0].n, 0)
})

test('(c) o dispatcher entrega ao receptor HTTP no envelope da Evolution', { skip }, async () => {
  await store.saveMessage(SESSION, sample('OK1'), 'inbound', { onInserted: enqueueUpsert })
  await dispatcher().processBatch()
  const [delivery] = await deliveries()
  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.attempts, 1)
  assert.equal(delivery.last_status_code, 200)
  assert.ok(delivery.delivered_at)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].event, 'messages.upsert')
  assert.equal(hits[0].deliveryId, String(delivery.id))
  assert.equal(hits[0].body.event, 'messages.upsert')
  assert.equal(hits[0].body.instance, SESSION)
  assert.equal(hits[0].body.sender, `${SESSION}@s.whatsapp.net`)
  assert.equal(hits[0].body.apikey, null)
  assert.equal(hits[0].body.data.key.id, 'OK1')
  // Cabeçalho cifrado no banco, em claro só no POST pro receptor.
  assert.equal(hits[0].teste, 'sim')
  const { rows } = await db.pool.query('SELECT headers FROM wa_webhooks WHERE session_id = $1', [SESSION])
  assert.match(rows[0].headers['X-Teste'], /^enc:v1:/)
})

test('(h) receptor lento não segura as entregas de outro webhook (limite por webhook)', { skip }, async () => {
  const { webhook: slow } = await service.createWebhook(SESSION, {
    url: serverUrl.replace('/hook', '/lento'),
    enabled: true,
    events: ['MESSAGES_UPSERT'],
    base64: false,
    byEvents: false,
    includeFromMe: false,
    headers: {}
  })
  // 6 mensagens: cada uma gera 1 entrega pro webhook rápido e 1 pro lento.
  for (let i = 0; i < 6; i++) {
    await store.saveMessage(SESSION, sample(`FAIR${i}`), 'inbound', { onInserted: enqueueUpsert })
  }
  // Um lote com 4 vagas e no máximo 2 por webhook: os dois webhooks entram.
  await dispatcher({ concurrency: 4, concurrencyPerWebhook: 2 }).processBatch()
  const slowHits = hits.filter((hit) => hit.url.startsWith('/lento')).length
  const fastHits = hits.length - slowHits
  assert.equal(slowHits, 2, 'o lento ficou no limite dele')
  assert.equal(fastHits, 2, 'o rápido não esperou a fila do lento')
  const pendingSlow = await db.pool.query(`SELECT count(*)::int AS n FROM wa_webhook_deliveries WHERE webhook_id = $1 AND status = 'pending'`, [slow.id])
  assert.equal(pendingSlow.rows[0].n, 4)
})

test('(j) purgeOldMessages apaga só as antigas e mantém o histórico de entregas', { skip }, async () => {
  await store.saveMessage(SESSION, sample('OLD1'), 'inbound', { onInserted: enqueueUpsert })
  await store.saveMessage(SESSION, sample('NEW1'), 'inbound', { onInserted: enqueueUpsert })
  await db.pool.query(`UPDATE wa_messages SET created_at = now() - interval '40 days' WHERE key_id = 'OLD1'`)
  const removed = await store.purgeOldMessages(30)
  assert.ok(removed >= 1)
  const { rows } = await db.pool.query('SELECT key_id FROM wa_messages WHERE session_id = $1', [SESSION])
  assert.deepEqual(rows.map((r) => r.key_id), ['NEW1'])
  const all = await deliveries()
  assert.equal(all.length, 2, 'as entregas continuam')
  assert.equal(all.filter((d) => d.message_id === null).length, 1, 'a da mensagem apagada perde só o vínculo')
})

test('(i) cabeçalho que não decifra (chave trocada) falha na hora, sem enviar', { skip }, async () => {
  await store.saveMessage(SESSION, sample('KEY1'), 'inbound', { onInserted: enqueueUpsert })
  await dispatcher({ cipher: secretsModule.createHeaderCipher('outra-chave-qualquer') }).processBatch()
  const [delivery] = await deliveries()
  assert.equal(delivery.status, 'failed')
  assert.match(delivery.last_error, /decifrar o cabeçalho "X-Teste"/)
  assert.equal(hits.length, 0, 'nada foi enviado sem o cabeçalho')
})

test('(d) 503 volta para pending com attempts = 1 e próxima tentativa no futuro', { skip }, async () => {
  responder = () => 503
  await store.saveMessage(SESSION, sample('RETRY1'), 'inbound', { onInserted: enqueueUpsert })
  await dispatcher().processBatch()
  const [delivery] = await deliveries()
  assert.equal(delivery.status, 'pending')
  assert.equal(delivery.attempts, 1)
  assert.equal(delivery.last_status_code, 503)
  assert.equal(delivery.last_error, 'HTTP 503')
  assert.ok(new Date(delivery.next_attempt_at) > new Date(), 'next_attempt_at no futuro')
})

test('(e) 401 vira failed depois de 1 tentativa', { skip }, async () => {
  responder = () => 401
  await store.saveMessage(SESSION, sample('FAIL1'), 'inbound', { onInserted: enqueueUpsert })
  await dispatcher().processBatch()
  const [delivery] = await deliveries()
  assert.equal(delivery.status, 'failed')
  assert.equal(delivery.attempts, 1)
  assert.equal(delivery.last_status_code, 401)
})

test('(f) delivering com lease vencido é reprocessado', { skip }, async () => {
  await store.saveMessage(SESSION, sample('LEASE1'), 'inbound', { onInserted: enqueueUpsert })
  await db.pool.query(
    `UPDATE wa_webhook_deliveries SET status = 'delivering', attempts = 1, locked_until = now() - interval '1 minute' WHERE session_id = $1`,
    [SESSION]
  )
  await dispatcher().processBatch()
  const [delivery] = await deliveries()
  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.attempts, 2)
})

test('(g) dois dispatchers concorrentes não entregam a mesma linha duas vezes (SKIP LOCKED)', { skip }, async () => {
  for (let i = 0; i < 20; i++) {
    await store.saveMessage(SESSION, sample(`CONC${i}`), 'inbound', { onInserted: enqueueUpsert })
  }
  await Promise.all([dispatcher().processBatch(), dispatcher().processBatch()])
  const ids = hits.map((hit) => hit.deliveryId)
  assert.equal(new Set(ids).size, ids.length, 'nenhuma entrega repetida')
  // O que um lote não pegou, o próximo pega.
  await dispatcher().processBatch()
  const rows = await deliveries()
  assert.equal(rows.length, 20)
  assert.ok(rows.every((row) => row.status === 'delivered'))
  assert.equal(hits.length, 20)
})
