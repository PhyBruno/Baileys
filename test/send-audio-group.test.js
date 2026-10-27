import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createSendMessageHandler, parseRecipientNumber } from '../outbound.js'

// POST /sessions/:id/messages com socket falso: destino de grupo (@g.us) e
// type "audio" (com ptt), mais a regressão do que já existia (texto, imagem,
// documento, vídeo e destino em dígitos). A rota é a real (outbound.js); as
// dependências do server.js que mexem no processo são trocadas por gravadores.

const SESSION = '5511900000001'
const OWN_PN = '5511900000001:7@s.whatsapp.net'
const OWN_LID = '99900000000001:7@lid'
const PEER = '5511977777777@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const LEGACY_GROUP = '120363000000000001-1600000000@g.us'
const OGG = Buffer.from('OggS\u0000\u0002fake-opus-payload')
const OGG_DATA_URL = `data:audio/ogg;base64,${OGG.toString('base64')}`
const PNG = Buffer.from('\u0089PNG fake image')

let server, port
let entry, calls
let cachedMetadata = {}

function fakeSocket({ groups = {}, registered = { '5511977777777': PEER } } = {}) {
  return {
    user: { id: OWN_PN, lid: OWN_LID },
    async onWhatsApp(number) {
      calls.onWhatsApp.push(number)
      const jid = registered[number]
      return jid ? [{ exists: true, jid }] : []
    },
    async groupMetadata(jid) {
      calls.groupMetadata.push(jid)
      const metadata = groups[jid]
      if (!metadata) throw new Error('item-not-found')
      return metadata
    },
    async sendMessage(jid, content, options) {
      calls.sendMessage.push({ jid, content, options })
      return { key: { remoteJid: jid, fromMe: true, id: options.messageId }, message: { fake: true } }
    }
  }
}

function groupWith(...participants) {
  return { id: GROUP, subject: 'Grupo Exemplo', participants: participants.map((p) => ({ admin: null, ...p })) }
}

before(async () => {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.post(
    '/sessions/:id/messages',
    createSendMessageHandler({
      getConnectedEntry: (id, res) => {
        if (id !== SESSION || !entry) {
          res.status(404).json({ error: 'sessão não encontrada ou não ativa neste processo' })
          return null
        }
        return entry
      },
      generateMessageId: (userJid) => {
        calls.generateMessageId.push(userJid)
        return `3EB0TESTE${calls.generateMessageId.length}`
      },
      waitForStatus: async (sock, messageId) => {
        calls.waitForStatus.push(messageId)
        return null
      },
      cacheSentMessage: (e, messageId, message) => calls.cacheSentMessage.push({ messageId, message }),
      recordApiMessage: async (id, e, full) => calls.recordApiMessage.push({ id, keyId: full?.key?.id }),
      respondWithMessageStatus: async (res, messageId, statusPromise) => {
        await statusPromise
        res.json({ ok: true, id: messageId, status: 'unknown' })
      },
      cachedGroupMetadata: async (id, jid) => (id === SESSION ? cachedMetadata[jid] : undefined),
      log: { error() {} }
    })
  )
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  calls = {
    onWhatsApp: [],
    groupMetadata: [],
    sendMessage: [],
    generateMessageId: [],
    waitForStatus: [],
    cacheSentMessage: [],
    recordApiMessage: [],
    marked: []
  }
  cachedMetadata = {}
  setSocket(fakeSocket())
})

function setSocket(sock) {
  entry = { sock, apiMessageIds: { mark: (messageId) => calls.marked.push(messageId) } }
}

async function send(body) {
  const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

function assertNothingSent() {
  assert.equal(calls.sendMessage.length, 0, 'não pode chamar sendMessage')
  assert.equal(calls.marked.length, 0, 'não pode registrar id de envio')
}

// O fluxo comum do envio: id gerado antes e registrado, o mesmo id no
// sendMessage, espera de status, cache de retry e gravação em wa_messages.
function assertCommonFlow(res, jid) {
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(calls.sendMessage.length, 1)
  const [sent] = calls.sendMessage
  assert.equal(sent.jid, jid)
  assert.deepEqual(calls.generateMessageId, [OWN_PN])
  assert.deepEqual(calls.marked, [sent.options.messageId])
  assert.deepEqual(res.body, { ok: true, id: sent.options.messageId, status: 'unknown' })
  assert.deepEqual(calls.waitForStatus, [sent.options.messageId])
  assert.deepEqual(calls.cacheSentMessage, [{ messageId: sent.options.messageId, message: { fake: true } }])
  assert.deepEqual(calls.recordApiMessage, [{ id: SESSION, keyId: sent.options.messageId }])
  return sent
}

// ---------------------------------------------------------------- (a) grupo

for (const jid of [GROUP, LEGACY_GROUP]) {
  test(`(a) grupo ${jid} é aceito, confere a participação e não chama onWhatsApp`, async () => {
    setSocket(fakeSocket({ groups: { [jid]: { ...groupWith({ id: OWN_PN.replace(':7', '') }, { id: PEER }), id: jid } } }))
    const res = await send({ to: jid, type: 'text', message: 'Bom dia, grupo' })
    const sent = assertCommonFlow(res, jid)
    assert.deepEqual(sent.content, { text: 'Bom dia, grupo' })
    assert.deepEqual(calls.groupMetadata, [jid])
    assert.equal(calls.onWhatsApp.length, 0, 'onWhatsApp não existe para grupo')
  })
}

test('(a) grupo com participantes em LID: o número participa pelo próprio LID', async () => {
  setSocket(fakeSocket({ groups: { [GROUP]: groupWith({ id: '99900000000001@lid' }, { id: '99900000000002@lid' }) } }))
  const res = await send({ to: GROUP, message: 'oi' })
  assertCommonFlow(res, GROUP)
})

test('(a) grupo em LID com phoneNumber do participante igual ao número da sessão', async () => {
  setSocket(fakeSocket({ groups: { [GROUP]: groupWith({ id: '88800000000001@lid', phoneNumber: '5511900000001@s.whatsapp.net' }) } }))
  const res = await send({ to: GROUP, message: 'oi' })
  assertCommonFlow(res, GROUP)
})

test('(a) grupo aceita mídia (áudio de voz) como o individual', async () => {
  setSocket(fakeSocket({ groups: { [GROUP]: groupWith({ id: '5511900000001@s.whatsapp.net' }) } }))
  const res = await send({ to: GROUP, type: 'audio', mediaBase64: OGG_DATA_URL, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  const sent = assertCommonFlow(res, GROUP)
  assert.equal(sent.content.ptt, true)
})

test('(a) participação vinda do cache em memória não consulta o WhatsApp', async () => {
  cachedMetadata = { [GROUP]: groupWith({ id: '5511900000001@s.whatsapp.net' }) }
  const res = await send({ to: GROUP, message: 'oi' })
  assertCommonFlow(res, GROUP)
  assert.equal(calls.groupMetadata.length, 0)
})

// ----------------------------------------------------- (b) sem participação

const GROUP_NOT_FOUND = { error: 'grupo não encontrado ou o número não participa' }

test('(b) groupMetadata falha → 404 sem enviar', async () => {
  const res = await send({ to: GROUP, message: 'oi' })
  assert.equal(res.status, 404)
  assert.deepEqual(res.body, GROUP_NOT_FOUND)
  assert.deepEqual(calls.groupMetadata, [GROUP])
  assert.equal(calls.onWhatsApp.length, 0)
  assertNothingSent()
})

test('(b) o número não participa do grupo → 404 sem enviar', async () => {
  setSocket(fakeSocket({ groups: { [GROUP]: groupWith({ id: PEER }, { id: '99900000000009@lid' }) } }))
  const res = await send({ to: GROUP, message: 'oi' })
  assert.equal(res.status, 404)
  assert.deepEqual(res.body, GROUP_NOT_FOUND)
  assertNothingSent()
})

test('(b) metadata sem lista de participantes → 404', async () => {
  setSocket(fakeSocket({ groups: { [GROUP]: { id: GROUP, subject: 'x' } } }))
  const res = await send({ to: GROUP, message: 'oi' })
  assert.equal(res.status, 404)
  assert.deepEqual(res.body, GROUP_NOT_FOUND)
  assertNothingSent()
})

// ------------------------------------------------- (c) outros formatos de JID

for (const to of [
  '98765432100000@lid',
  '120363000000000001@newsletter',
  '5511977777777@s.whatsapp.net',
  'status@broadcast',
  '120363000000000001@g.us.exemplo',
  'abc@g.us',
  '120363000000000001-@g.us'
]) {
  test(`(c) "to" ${to} continua 400`, async () => {
    const res = await send({ to, message: 'oi' })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /formato de "to" inválido/)
    assert.equal(calls.groupMetadata.length + calls.onWhatsApp.length, 0)
    assertNothingSent()
  })
}

test('(c) sendButtons/sendList continuam recusando grupo, @lid e @newsletter', () => {
  for (const number of [GROUP, LEGACY_GROUP, '98765432100000@lid', '120363000000000001@newsletter']) {
    assert.equal(parseRecipientNumber(number), null, number)
  }
  assert.equal(parseRecipientNumber('5511977777777@s.whatsapp.net'), '5511977777777')
})

// ------------------------------------------------------------- (d)-(g) áudio

test('(d) audio com ptt: true sai como mensagem de voz', async () => {
  const res = await send({ to: '5511977777777', type: 'audio', mediaBase64: OGG_DATA_URL, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  const sent = assertCommonFlow(res, PEER)
  assert.deepEqual(sent.content, { audio: OGG, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  assert.ok(Buffer.isBuffer(sent.content.audio))
})

test('(e) audio sem ptt sai como arquivo de áudio (ptt: false)', async () => {
  const res = await send({ to: '5511977777777', type: 'audio', mediaBase64: OGG.toString('base64'), mimetype: 'audio/mpeg' })
  const sent = assertCommonFlow(res, PEER)
  assert.deepEqual(sent.content, { audio: OGG, mimetype: 'audio/mpeg', ptt: false })
})

test('(e) ptt que não é o booleano true conta como false', async () => {
  const res = await send({ to: '5511977777777', type: 'audio', mediaBase64: OGG_DATA_URL, mimetype: 'audio/ogg', ptt: 'true' })
  const sent = assertCommonFlow(res, PEER)
  assert.equal(sent.content.ptt, false)
})

test('(f) audio sem mimetype → 400', async () => {
  const res = await send({ to: '5511977777777', type: 'audio', mediaBase64: OGG_DATA_URL, ptt: true })
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'informe "mimetype" (obrigatório quando "type" é "audio")' })
  assertNothingSent()
})

test('(g) audio com base64 inválido ou ausente → 400', async () => {
  for (const mediaBase64 of ['não é base64!!', 'data:audio/ogg;base64,', '   ']) {
    const res = await send({ to: '5511977777777', type: 'audio', mediaBase64, mimetype: 'audio/ogg; codecs=opus' })
    assert.equal(res.status, 400, mediaBase64)
    assert.match(res.body.error, /"mediaBase64" inválido ou vazio/)
  }
  const missing = await send({ to: '5511977777777', type: 'audio', mimetype: 'audio/ogg; codecs=opus' })
  assert.equal(missing.status, 400)
  assert.deepEqual(missing.body, { error: 'informe "mediaBase64" no corpo (obrigatório quando "type" é "audio")' })
  assertNothingSent()
})

// ------------------------------------------------------------ (h) regressão

test('(h) texto para dígitos: resolve pelo onWhatsApp e envia ao JID canônico', async () => {
  const res = await send({ to: '5511977777777', message: 'Olá' })
  const sent = assertCommonFlow(res, PEER)
  assert.deepEqual(sent.content, { text: 'Olá' })
  assert.deepEqual(calls.onWhatsApp, ['5511977777777'])
  assert.equal(calls.groupMetadata.length, 0)
})

test('(h) dígitos com "+", espaço e traço continuam aceitos', async () => {
  const res = await send({ to: '+55 11 97777-7777', type: 'text', message: 'Olá' })
  assertCommonFlow(res, PEER)
  assert.deepEqual(calls.onWhatsApp, ['5511977777777'])
})

test('(h) número não registrado → 404', async () => {
  const res = await send({ to: '5511966666666', message: 'Olá' })
  assert.equal(res.status, 404)
  assert.deepEqual(res.body, { error: 'número "5511966666666" não está registrado no WhatsApp (ou não foi possível confirmar)' })
  assertNothingSent()
})

test('(h) imagem, documento e vídeo inalterados', async () => {
  const media = PNG.toString('base64')
  let sent = assertCommonFlow(await send({ to: '5511977777777', type: 'image', mediaBase64: media, caption: 'foto' }), PEER)
  assert.deepEqual(sent.content, { image: PNG, caption: 'foto' })

  beforeEachReset()
  sent = assertCommonFlow(await send({ to: '5511977777777', type: 'image', mediaBase64: `data:image/png;base64,${media}`, mimetype: 'image/png' }), PEER)
  assert.deepEqual(sent.content, { image: PNG, caption: undefined, mimetype: 'image/png' })

  beforeEachReset()
  sent = assertCommonFlow(await send({ to: '5511977777777', type: 'document', mediaBase64: media, mimetype: 'application/pdf' }), PEER)
  assert.deepEqual(sent.content, { document: PNG, mimetype: 'application/pdf', fileName: 'arquivo', caption: undefined })

  beforeEachReset()
  sent = assertCommonFlow(
    await send({ to: '5511977777777', type: 'document', mediaBase64: media, mimetype: 'application/pdf', fileName: 'nota.pdf', caption: 'segue' }),
    PEER
  )
  assert.deepEqual(sent.content, { document: PNG, mimetype: 'application/pdf', fileName: 'nota.pdf', caption: 'segue' })

  beforeEachReset()
  sent = assertCommonFlow(await send({ to: '5511977777777', type: 'video', mediaBase64: media, mimetype: 'video/mp4', caption: 'vídeo' }), PEER)
  assert.deepEqual(sent.content, { video: PNG, mimetype: 'video/mp4', caption: 'vídeo' })
})

test('(h) recusas existentes inalteradas', async () => {
  const cases = [
    [{ message: 'sem to' }, { error: 'informe "to" no corpo' }],
    [{ to: '123', message: 'curto' }, { error: 'formato de "to" inválido. Use apenas dígitos com DDI, ex: 5511999999999' }],
    [{ to: '5511977777777', type: 'text' }, { error: 'informe "message" no corpo (obrigatório quando "type" é "text")' }],
    [{ to: '5511977777777', type: 'document', mediaBase64: 'QUJD' }, { error: 'informe "mimetype" no corpo (obrigatório quando "type" é "document")' }],
    [{ to: '5511977777777', type: 'video', mediaBase64: 'QUJD' }, { error: 'informe "mimetype" no corpo (obrigatório quando "type" é "video")' }],
    [{ to: '5511977777777', type: 'sticker', mediaBase64: 'QUJD' }, { error: 'campo "type" inválido. Use "text" (default), "image", "video", "document" ou "audio".' }]
  ]
  for (const [body, expected] of cases) {
    const res = await send(body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.deepEqual(res.body, expected)
  }
  assertNothingSent()
})

function beforeEachReset() {
  for (const list of Object.values(calls)) list.length = 0
}
