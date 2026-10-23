import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { lockDatabase } from './dbLock.js'
import express from 'express'

// Integração do nome dos grupos (wa_groups, histórico e webhook) contra um
// Postgres de teste, como test/integration/outbox.test.js:
//   TEST_DATABASE_URL=postgres://user:senha@localhost:5432/wsb_test npm test
// Sessão própria: os arquivos de teste rodam em paralelo.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = TEST_DATABASE_URL ? false : 'defina TEST_DATABASE_URL para rodar o teste de integração de grupos'

const SESSION = '5511900000098'
const G1 = '120363000000000011@g.us'
const G2 = '120363000000000012@g.us'
const G3 = '120363000000000013@g.us'
const PEER = '5511988887777@s.whatsapp.net'
const silent = { info() {}, warn() {}, debug() {}, error() {} }

let unlockDatabase
let db, store, groupsModule, routesModule, webhooksModule, dispatcherModule, secretsModule
let app, api, receiver, receiverUrl
const hits = []
let socket = null
const calls = []

const message = (remoteJid, id, participant) => ({
  key: { remoteJid, fromMe: false, id, ...(participant ? { participant } : {}), addressingMode: 'pn' },
  pushName: 'Pessoa Exemplo',
  status: 'DELIVERY_ACK',
  message: { conversation: `mensagem ${id}` },
  contextInfo: null,
  messageType: 'conversation',
  messageTimestamp: 1792750000,
  instanceId: SESSION,
  source: 'android'
})

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// Fecha o servidor da rota sem esperar as conexões keep-alive do fetch.
async function closeApp() {
  if (!app) return
  app.closeAllConnections()
  await new Promise((resolve) => app.close(resolve))
  app = null
}

before(async () => {
  if (skip) return
  process.env.DATABASE_URL = TEST_DATABASE_URL
  db = await import('../../db.js')
  store = await import('../../messageStore.js')
  groupsModule = await import('../../groupMetadata.js')
  routesModule = await import('../../webhookRoutes.js')
  webhooksModule = await import('../../webhooks.js')
  dispatcherModule = await import('../../webhookDispatcher.js')
  secretsModule = await import('../../secrets.js')
  unlockDatabase = await lockDatabase(db.pool)
  await db.migrate()

  receiver = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      hits.push(JSON.parse(body))
      res.end('ok')
    })
  })
  receiverUrl = `http://127.0.0.1:${await listen(receiver)}/hook`
})

after(async () => {
  if (skip) return
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  await unlockDatabase?.()
  await db.pool.end()
  await new Promise((resolve) => receiver.close(resolve))
  await closeApp()
})

let groups
beforeEach(async () => {
  if (skip) return
  hits.length = 0
  calls.length = 0
  socket = null
  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  await db.pool.query(`INSERT INTO wa_sessions (id, status) VALUES ($1, 'connected')`, [SESSION])
  groups = groupsModule.createGroupMetadataCache({ pool: db.pool, getSocket: () => socket ?? undefined, log: silent })

  // Rota real do histórico, com o cache deste caso (recriado a cada caso).
  await closeApp()
  const server = express()
  server.use('/sessions/:id', (req, res, next) =>
    routesModule.default({ sessions: new Map(), pool: db.pool, groups, historyLimits: { maxLookups: 10, budgetMs: 2_000 } })(req, res, next)
  )
  app = http.createServer(server)
  const port = await listen(app)
  api = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION}${path}`)
    return { status: res.status, body: await res.json() }
  }
})

const fakeSocket = (subjects) => ({
  async groupMetadata(jid) {
    calls.push(jid)
    if (!(jid in subjects)) throw new Error('item-not-found')
    return { id: jid, subject: subjects[jid], participants: [] }
  }
})

test('wa_groups: write-through em lote, troca de nome e CASCADE ao apagar a sessão', { skip }, async () => {
  await groups.onGroupsUpsert(SESSION, [
    { id: G1, subject: 'Grupo Um' },
    { id: G2, subject: 'Grupo Dois' },
    { id: G1, subject: 'Grupo Um (repetido no lote)' }
  ])
  await groups.onGroupsUpdate(SESSION, [{ id: G2, subject: 'Grupo Dois Renomeado' }])
  const { rows } = await db.pool.query('SELECT jid, subject FROM wa_groups WHERE session_id = $1 ORDER BY jid', [SESSION])
  assert.deepEqual(rows, [
    { jid: G1, subject: 'Grupo Um (repetido no lote)' },
    { jid: G2, subject: 'Grupo Dois Renomeado' }
  ])

  await db.pool.query('DELETE FROM wa_sessions WHERE id = $1', [SESSION])
  const left = await db.pool.query('SELECT count(*)::int AS n FROM wa_groups WHERE session_id = $1', [SESSION])
  assert.equal(left.rows[0].n, 0)
})

test('histórico: 3 grupos e 1 individual, nomes do L2 e do WhatsApp, paginação inalterada', { skip }, async () => {
  for (const [jid, id] of [
    [G1, 'H1'],
    [PEER, 'H2'],
    [G2, 'H3'],
    [G3, 'H4'],
    [G1, 'H5']
  ]) {
    await store.saveMessage(SESSION, message(jid, id, jid === PEER ? undefined : PEER), 'inbound')
  }
  await db.pool.query(`INSERT INTO wa_groups (session_id, jid, subject) VALUES ($1, $2, 'Grupo Um')`, [SESSION, G1])
  socket = fakeSocket({ [G2]: 'Grupo Dois' })

  const expected = await store.listMessages(SESSION, { limit: 3 })
  const page1 = await api('/messages?limit=3')
  assert.equal(page1.status, 200)
  assert.equal(page1.body.nextBefore, expected.nextBefore)
  assert.deepEqual(
    page1.body.items.map((i) => i.key.id),
    expected.items.map((i) => i.key.id)
  )
  assert.deepEqual(
    page1.body.items.map((i) => [i.key.id, i.groupSubject]),
    [
      ['H5', 'Grupo Um'],
      ['H4', null],
      ['H3', 'Grupo Dois']
    ]
  )

  const page2 = await api(`/messages?limit=3&before=${page1.body.nextBefore}`)
  assert.equal(page2.status, 200)
  assert.equal(page2.body.nextBefore, null)
  assert.deepEqual(
    page2.body.items.map((i) => [i.key.id, 'groupSubject' in i ? i.groupSubject : 'sem campo']),
    [
      ['H2', 'sem campo'],
      ['H1', 'Grupo Um']
    ]
  )
  assert.deepEqual(calls.sort(), [G2, G3].sort(), 'G1 veio do banco; G2 e G3 foram consultados uma vez')
  assert.equal(
    (await db.pool.query('SELECT subject FROM wa_groups WHERE session_id = $1 AND jid = $2', [SESSION, G2])).rows[0].subject,
    'Grupo Dois',
    'resultado do WhatsApp gravado em wa_groups'
  )
})

test('histórico com a sessão desconectada responde pelo wa_groups; remoteJid=<grupo> resolve uma vez', { skip }, async () => {
  await store.saveMessage(SESSION, message(G1, 'D1', PEER), 'inbound')
  await store.saveMessage(SESSION, message(G1, 'D2', PEER), 'inbound')
  await db.pool.query(`INSERT INTO wa_groups (session_id, jid, subject) VALUES ($1, $2, 'Grupo Um')`, [SESSION, G1])
  const res = await api(`/messages?remoteJid=${encodeURIComponent(G1)}`)
  assert.equal(res.status, 200)
  assert.deepEqual(
    res.body.items.map((i) => i.groupSubject),
    ['Grupo Um', 'Grupo Um']
  )
  assert.equal(calls.length, 0)
})

test('webhook: data.groupSubject no envio, sem o nome no payload gravado em wa_webhook_deliveries', { skip }, async () => {
  const cipher = secretsModule.createHeaderCipher('chave-de-teste-de-grupos')
  const service = webhooksModule.createWebhookService({ pool: db.pool, cipher })
  await service.createWebhook(SESSION, {
    url: receiverUrl,
    enabled: true,
    events: ['MESSAGES_UPSERT'],
    base64: false,
    byEvents: false,
    includeFromMe: false,
    headers: {}
  })
  socket = fakeSocket({ [G1]: 'Grupo Um' })
  const enqueue = (client, row) =>
    service.enqueue(client, SESSION, 'MESSAGES_UPSERT', store.webhookDataFromRow(row), { messageId: row.id, origin: row.origin })
  await store.saveMessage(SESSION, message(G1, 'W1', PEER), 'inbound', { onInserted: enqueue })
  await store.saveMessage(SESSION, message(PEER, 'W2'), 'inbound', { onInserted: enqueue })

  const dispatcher = dispatcherModule.createDispatcher({
    pool: db.pool,
    cipher,
    groups,
    log: silent,
    config: {
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
  })
  assert.equal(await dispatcher.processBatch(), 2)

  const byKey = Object.fromEntries(hits.map((body) => [body.data.key.id, body.data]))
  assert.equal(byKey.W1.groupSubject, 'Grupo Um')
  assert.equal('groupSubject' in byKey.W2, false)

  const { rows } = await db.pool.query('SELECT status, payload FROM wa_webhook_deliveries WHERE session_id = $1', [SESSION])
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.status, 'delivered')
    assert.equal('groupSubject' in row.payload, false)
  }
})
