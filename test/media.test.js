import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BufferJSON } from 'baileys'
import {
  buildBase64Response,
  extensionFor,
  exceedsMaxBytes,
  deserializeBinary,
  createMediaCache,
  safeMediaMessage,
  downloadMedia
} from '../media.js'
import { prepareMessage, serializeBinary } from '../inbound.js'

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/messages/${name}.json`, import.meta.url), 'utf-8'), BufferJSON.reviver)
const dataOf = (name) => {
  const received = fixture(name)
  return prepareMessage(received, { instanceId: '5511900000001', key: received.key })
}

// ---------------- (a) buildBase64Response ----------------

test('buildBase64Response no formato do getBase64FromMediaMessage da Evolution', () => {
  const data = dataOf('image')
  const response = buildBase64Response(data, Buffer.from('conteudo'))
  assert.deepEqual(response, {
    mediaType: 'imageMessage',
    fileName: `${data.key.id}.jpeg`,
    caption: 'foto',
    size: { fileLength: 48213, height: 1280, width: 720 },
    mimetype: 'image/jpeg',
    base64: Buffer.from('conteudo').toString('base64')
  })
})

test('buildBase64Response usa o fileName do documento quando existe', () => {
  const response = buildBase64Response(dataOf('document'), Buffer.from('pdf'))
  assert.equal(response.fileName, 'boleto.pdf')
  assert.equal(response.mediaType, 'documentMessage')
  assert.equal(response.mimetype, 'application/pdf')
})

// ---------------- (b) extensionFor ----------------

test('extensionFor', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpeg')
  assert.equal(extensionFor('image/png'), 'png')
  assert.equal(extensionFor('image/webp'), 'webp')
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(extensionFor('audio/mpeg'), 'mp3')
  assert.equal(extensionFor('video/mp4'), 'mp4')
  assert.equal(extensionFor('application/pdf'), 'pdf')
  assert.equal(extensionFor('application/x-desconhecido'), 'bin')
  assert.equal(extensionFor(undefined), 'bin')
})

// ---------------- (c) exceedsMaxBytes ----------------

test('exceedsMaxBytes lê fileLength como número ou string', () => {
  assert.equal(exceedsMaxBytes(dataOf('image'), 48212), true)
  assert.equal(exceedsMaxBytes(dataOf('image'), 48213), false)
  assert.equal(exceedsMaxBytes(dataOf('audio-ptt'), 10_000), true, 'fileLength em string')
  assert.equal(exceedsMaxBytes(dataOf('audio-ptt'), 20_000), false)
  assert.equal(exceedsMaxBytes(dataOf('conversation'), 1), false, 'sem fileLength não dá pra saber antes')
})

// ---------------- (d) deserializeBinary ----------------

test('deserializeBinary é o inverso de serializeBinary nos campos binários', () => {
  const original = fixture('image').message
  delete original.imageMessage.fileLength
  delete original.imageMessage.mediaKeyTimestamp
  const roundTrip = deserializeBinary(serializeBinary(original))
  assert.equal(JSON.stringify(roundTrip, BufferJSON.replacer), JSON.stringify(original, BufferJSON.replacer))
  assert.ok(Buffer.isBuffer(roundTrip.imageMessage.mediaKey))
})

test('deserializeBinary aceita o objeto indexado da Evolution', () => {
  const out = deserializeBinary({ imageMessage: { mediaKey: { 0: 1, 1: 2, 2: 255 }, caption: 'foto' } })
  assert.deepEqual([...out.imageMessage.mediaKey], [1, 2, 255])
  assert.equal(out.imageMessage.caption, 'foto')
})

test('deserializeBinary não mexe em texto fora dos campos binários', () => {
  const out = deserializeBinary({ conversation: 'QUJD', imageMessage: { caption: 'QUJD' } })
  assert.equal(out.conversation, 'QUJD')
  assert.equal(out.imageMessage.caption, 'QUJD')
})

// ---------------- SSRF: só o CDN oficial ----------------

test('safeMediaMessage troca a url pelo host oficial a partir do directPath', () => {
  const message = {
    imageMessage: { url: 'http://servico-interno:8080/admin', directPath: '/v/t62.7118-24/000_n.enc?ccb=11-4', mimetype: 'image/jpeg' }
  }
  const safe = safeMediaMessage(message, 'imageMessage')
  assert.equal(safe.imageMessage.url, 'https://mmg.whatsapp.net/v/t62.7118-24/000_n.enc?ccb=11-4')
  assert.equal(message.imageMessage.url, 'http://servico-interno:8080/admin', 'não altera a entrada')
})

test('safeMediaMessage recusa mensagem sem directPath confiável', () => {
  const cases = [undefined, '', 'v/sem-barra', '//evil.example/x', '/v/../../etc', '/v/x@evil.example', 'http://evil.example/x']
  for (const directPath of cases) {
    assert.equal(safeMediaMessage({ imageMessage: { url: 'http://169.254.169.254/', directPath } }, 'imageMessage'), null, String(directPath))
  }
})

test('downloadMedia nem tenta baixar mídia forjada sem directPath', async () => {
  const data = { key: { id: 'X' }, messageType: 'imageMessage', message: { imageMessage: { url: 'http://169.254.169.254/latest', mediaKey: 'AA==' } } }
  await assert.rejects(downloadMedia(undefined, data, { maxBytes: 1000, timeoutMs: 1000 }), { code: 'download_failed' })
})

// ---------------- (e) createMediaCache ----------------

test('createMediaCache reaproveita a mesma Promise e expira por TTL', async () => {
  let clock = 0
  const cache = createMediaCache({ ttlMs: 60_000, maxBytes: 1000, now: () => clock })
  let calls = 0
  const loader = async () => (calls++, Buffer.alloc(10))
  await Promise.all([cache.getOrLoad('a', loader), cache.getOrLoad('a', loader)])
  assert.equal(calls, 1, 'downloads concorrentes viram um só')
  clock += 59_999
  await cache.getOrLoad('a', loader)
  assert.equal(calls, 1)
  clock += 1
  await cache.getOrLoad('a', loader)
  assert.equal(calls, 2, 'expirou')
})

test('createMediaCache descarta os mais antigos acima de maxBytes', async () => {
  const cache = createMediaCache({ ttlMs: 60_000, maxBytes: 25, now: () => 0 })
  await cache.getOrLoad('a', async () => Buffer.alloc(10))
  await cache.getOrLoad('b', async () => Buffer.alloc(10))
  await cache.getOrLoad('c', async () => Buffer.alloc(10))
  assert.equal(cache.has('a'), false)
  assert.equal(cache.has('b'), true)
  assert.equal(cache.has('c'), true)
  assert.equal(cache.totalBytes, 20)
})

test('createMediaCache não guarda falha', async () => {
  const cache = createMediaCache({ ttlMs: 60_000, maxBytes: 100, now: () => 0 })
  await assert.rejects(cache.getOrLoad('x', async () => Promise.reject(new Error('falhou'))))
  assert.equal(cache.has('x'), false)
})
