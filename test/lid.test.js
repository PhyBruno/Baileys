import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isLidJid, makePnResolver, normalizeKeyAddressing, normalizeContextInfoAddressing } from '../lid.js'
import { prepareMessage } from '../inbound.js'
import { webhookDataFromRow } from '../messageStore.js'
import { buildEnvelope } from '../webhookDispatcher.js'

// JIDs sintéticos.
const PEER_PN = '5511988887777@s.whatsapp.net'
const PEER_LID = '123456789012345@lid'
const OWN_PN = '5511900000001@s.whatsapp.net'
const OWN_LID = '999999999999999@lid'
const GROUP = '120363000000000000@g.us'
const ownJids = [`${OWN_PN.split('@')[0]}:7@s.whatsapp.net`, OWN_LID]

const resolverFrom = (map) => async (lid) => map[lid] ?? null

test('isLidJid reconhece @lid e @hosted.lid', () => {
  assert.equal(isLidJid(PEER_LID), true)
  assert.equal(isLidJid('123@hosted.lid'), true)
  assert.equal(isLidJid(PEER_PN), false)
  assert.equal(isLidJid(GROUP), false)
  assert.equal(isLidJid(undefined), false)
})

test('1:1 recebida em LID com PN no alt: troca pra PN (formato Evolution)', async () => {
  let called = false
  const key = { remoteJid: PEER_LID, remoteJidAlt: PEER_PN, fromMe: false, id: 'A1', addressingMode: 'lid' }
  const out = await normalizeKeyAddressing(key, { resolvePn: async () => ((called = true), null), ownJids })
  assert.deepEqual(out, { remoteJid: PEER_PN, remoteJidAlt: PEER_LID, fromMe: false, id: 'A1', addressingMode: 'pn' })
  assert.equal(called, false, 'não consulta o mapeamento quando a stanza já trouxe o PN')
})

test('1:1 recebida em LID sem alt: resolve pelo mapeamento e remove sufixo de dispositivo', async () => {
  const key = { remoteJid: PEER_LID, fromMe: false, id: 'A2' }
  const out = await normalizeKeyAddressing(key, {
    resolvePn: resolverFrom({ [PEER_LID]: '5511988887777:0@s.whatsapp.net' }),
    ownJids
  })
  assert.equal(out.remoteJid, PEER_PN)
  assert.equal(out.remoteJidAlt, PEER_LID)
  assert.equal(out.addressingMode, 'pn')
})

test('1:1 em LID sem PN conhecido: mantém LID com addressingMode lid', async () => {
  const key = { remoteJid: PEER_LID, fromMe: false, id: 'A3' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.remoteJid, PEER_LID)
  assert.equal('remoteJidAlt' in out, false)
  assert.equal(out.addressingMode, 'lid')
})

test('falha no resolver não propaga: segue com o LID', async () => {
  const key = { remoteJid: PEER_LID, fromMe: false, id: 'A4' }
  const out = await normalizeKeyAddressing(key, {
    resolvePn: async () => {
      throw new Error('boom')
    },
    ownJids
  })
  assert.equal(out.remoteJid, PEER_LID)
  assert.equal(out.addressingMode, 'lid')
})

test('1:1 recebida em PN com LID no alt: mantém e preserva o alt', async () => {
  const key = { remoteJid: PEER_PN, remoteJidAlt: PEER_LID, fromMe: false, id: 'A5', addressingMode: 'pn' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.remoteJid, PEER_PN)
  assert.equal(out.remoteJidAlt, PEER_LID)
  assert.equal(out.addressingMode, 'pn')
})

test('fromMe em LID com alt = nosso próprio PN: descarta o alt e usa o mapeamento', async () => {
  // Caso em que a Evolution grava a conversa com o próprio número da instância.
  const key = { remoteJid: PEER_LID, remoteJidAlt: OWN_PN, fromMe: true, id: 'A6' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({ [PEER_LID]: PEER_PN }), ownJids })
  assert.equal(out.remoteJid, PEER_PN)
  assert.equal(out.remoteJidAlt, PEER_LID)
})

test('fromMe em LID com alt = nosso PN e sem mapeamento: fica no LID, nunca no próprio número', async () => {
  const key = { remoteJid: PEER_LID, remoteJidAlt: OWN_PN, fromMe: true, id: 'A7' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.remoteJid, PEER_LID)
  assert.equal(out.addressingMode, 'lid')
})

test('fromMe em LID com alt = PN do contato (peer_recipient_pn): usa o alt', async () => {
  const key = { remoteJid: PEER_LID, remoteJidAlt: PEER_PN, fromMe: true, id: 'A8' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.remoteJid, PEER_PN)
  assert.equal(out.remoteJidAlt, PEER_LID)
})

test('fromMe em PN com alt = nosso LID: remove o alt', async () => {
  const key = { remoteJid: PEER_PN, remoteJidAlt: OWN_LID, fromMe: true, id: 'A9' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.remoteJid, PEER_PN)
  assert.equal('remoteJidAlt' in out, false)
})

test('grupo com participant em LID e PN no participantAlt: troca o participant, grupo intacto', async () => {
  const key = { remoteJid: GROUP, participant: PEER_LID, participantAlt: PEER_PN, fromMe: false, id: 'G1' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.remoteJid, GROUP)
  assert.equal(out.participant, PEER_PN)
  assert.equal(out.participantAlt, PEER_LID)
  assert.equal(out.addressingMode, 'pn')
})

test('grupo com participant em LID sem alt: resolve pelo mapeamento', async () => {
  const key = { remoteJid: GROUP, participant: `${PEER_LID.split('@')[0]}:3@lid`, fromMe: false, id: 'G2' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({ [PEER_LID]: PEER_PN }), ownJids })
  assert.equal(out.participant, PEER_PN)
  assert.equal(out.participantAlt, PEER_LID)
})

test('grupo com participant em LID sem PN conhecido: mantém LID', async () => {
  const key = { remoteJid: GROUP, participant: PEER_LID, fromMe: false, id: 'G3' }
  const out = await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.participant, PEER_LID)
  assert.equal('participantAlt' in out, false)
  assert.equal(out.addressingMode, 'lid')
})

test('status@broadcast e newsletter passam sem alteração de endereço', async () => {
  const status = { remoteJid: 'status@broadcast', participant: PEER_LID, fromMe: false, id: 'S1' }
  assert.deepEqual(await normalizeKeyAddressing(status, { resolvePn: resolverFrom({}) }), status)
  const news = { remoteJid: '120363000000000001@newsletter', fromMe: false, id: 'N1' }
  assert.deepEqual(await normalizeKeyAddressing(news, { resolvePn: resolverFrom({}) }), news)
})

test('não altera o objeto key recebido', async () => {
  const key = { remoteJid: PEER_LID, remoteJidAlt: PEER_PN, fromMe: false, id: 'M1' }
  const snapshot = structuredClone(key)
  await normalizeKeyAddressing(key, { resolvePn: resolverFrom({}), ownJids })
  assert.deepEqual(key, snapshot)
})

test('makePnResolver usa signalRepository.lidMapping e engole erro', async () => {
  const ok = makePnResolver({
    signalRepository: { lidMapping: { getPNForLID: async () => '5511988887777:0@s.whatsapp.net' } }
  })
  assert.equal(await ok(PEER_LID), PEER_PN)

  const failing = makePnResolver({
    signalRepository: {
      lidMapping: {
        getPNForLID: async () => {
          throw new Error('db fora')
        }
      }
    }
  })
  assert.equal(await failing(PEER_LID), null)

  assert.equal(await makePnResolver({})(PEER_LID), null)
})

// ---------------- contextInfo (citação e menções) ----------------

const OTHER_LID = '555555555555555@lid'
const OTHER_PN = '5511977776666@s.whatsapp.net'

test('contextInfo: participant em LID com PN conhecido vira PN e guarda o LID em participantAlt', async () => {
  const ctx = { stanzaId: 'Q1', participant: PEER_LID, quotedMessage: { conversation: 'oi' } }
  const out = await normalizeContextInfoAddressing(ctx, { resolvePn: resolverFrom({ [PEER_LID]: PEER_PN }), ownJids })
  assert.deepEqual(out, { stanzaId: 'Q1', participant: PEER_PN, participantAlt: PEER_LID, quotedMessage: { conversation: 'oi' } })
})

test('contextInfo: participant em LID sem PN conhecido fica como veio e sem participantAlt', async () => {
  const out = await normalizeContextInfoAddressing({ participant: PEER_LID }, { resolvePn: resolverFrom({}), ownJids })
  assert.equal(out.participant, PEER_LID)
  assert.equal('participantAlt' in out, false)
})

test('contextInfo: participant já em PN não muda', async () => {
  let called = false
  const out = await normalizeContextInfoAddressing({ participant: PEER_PN }, { resolvePn: async () => ((called = true), null), ownJids })
  assert.deepEqual(out, { participant: PEER_PN })
  assert.equal(called, false)
})

test('contextInfo: participant igual ao número da sessão (citação de mensagem nossa) não muda', async () => {
  const out = await normalizeContextInfoAddressing({ participant: OWN_LID }, { resolvePn: resolverFrom({ [OWN_LID]: OWN_PN }), ownJids })
  assert.deepEqual(out, { participant: OWN_LID })
})

test('contextInfo: mentionedJid misto gera mentionedJidAlt paralelo com null nas posições não trocadas', async () => {
  const ctx = { mentionedJid: [OTHER_PN, PEER_LID, OTHER_LID] }
  const out = await normalizeContextInfoAddressing(ctx, { resolvePn: resolverFrom({ [PEER_LID]: PEER_PN }), ownJids })
  assert.deepEqual(out.mentionedJid, [OTHER_PN, PEER_PN, OTHER_LID])
  assert.deepEqual(out.mentionedJidAlt, [null, PEER_LID, null])
})

test('contextInfo: sem menção, ou sem LID trocado, não cria mentionedJidAlt', async () => {
  const resolvePn = resolverFrom({})
  for (const ctx of [{ stanzaId: 'Q2' }, { mentionedJid: [] }, { mentionedJid: [OTHER_PN] }, { mentionedJid: [OTHER_LID] }]) {
    const out = await normalizeContextInfoAddressing(ctx, { resolvePn, ownJids })
    assert.deepEqual(out, ctx)
    assert.equal('mentionedJidAlt' in out, false)
  }
})

test('contextInfo: erro do resolvedor não lança e deixa os campos como vieram', async () => {
  const ctx = { participant: PEER_LID, mentionedJid: [PEER_LID] }
  const out = await normalizeContextInfoAddressing(ctx, {
    resolvePn: async () => {
      throw new Error('boom')
    },
    ownJids
  })
  assert.deepEqual(out, ctx)
})

test('contextInfo: null volta null e o objeto recebido não é alterado', async () => {
  assert.equal(await normalizeContextInfoAddressing(null, { resolvePn: resolverFrom({}) }), null)
  assert.equal(await normalizeContextInfoAddressing(undefined, { resolvePn: resolverFrom({}) }), null)
  const ctx = { participant: PEER_LID, mentionedJid: [PEER_LID] }
  const snapshot = structuredClone(ctx)
  await normalizeContextInfoAddressing(ctx, { resolvePn: resolverFrom({ [PEER_LID]: PEER_PN }), ownJids })
  assert.deepEqual(ctx, snapshot)
})

// ---------------- contextInfo de ponta a ponta (fixtures) ----------------

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/messages/${name}.json`, import.meta.url), 'utf-8'))

// Mesmo caminho do server.js: key normalizada → prepareMessage →
// normalizeContextInfoAddressing → JSON gravado em wa_messages → data do webhook.
async function storedAndSent(name, map) {
  const received = fixture(name)
  const options = { resolvePn: resolverFrom(map), ownJids }
  const key = await normalizeKeyAddressing(received.key, options)
  const data = prepareMessage(received, { instanceId: '5511900000001', key })
  data.contextInfo = await normalizeContextInfoAddressing(data.contextInfo, options)
  const stored = JSON.parse(JSON.stringify(data.contextInfo))
  const row = {
    key: data.key,
    push_name: data.pushName,
    status: data.status,
    message: data.message,
    context_info: stored,
    message_type: data.messageType,
    message_timestamp: String(data.messageTimestamp),
    session_id: '5511900000001',
    source: data.source,
    origin: 'inbound'
  }
  const { body } = buildEnvelope({ event: 'MESSAGES_UPSERT', instance: '5511900000001', data: webhookDataFromRow(row), url: 'https://x.example' })
  return { stored, sent: body.data.contextInfo }
}

test('citação em grupo: o JSON gravado e o enviado trazem participant em PN e participantAlt', async () => {
  const { stored, sent } = await storedAndSent('group-quoted-lid', { [OTHER_LID]: OTHER_PN })
  assert.equal(stored.participant, OTHER_PN)
  assert.equal(stored.participantAlt, OTHER_LID)
  assert.deepEqual(sent, stored)
})

test('menção em grupo: o JSON gravado e o enviado trazem mentionedJid em PN e mentionedJidAlt', async () => {
  const { stored, sent } = await storedAndSent('group-mention', { [OTHER_LID]: '5511966665555@s.whatsapp.net' })
  assert.deepEqual(stored.mentionedJid, [OTHER_PN, '5511966665555@s.whatsapp.net'])
  assert.deepEqual(stored.mentionedJidAlt, [null, OTHER_LID])
  assert.deepEqual(sent, stored)
})

test('grupo com participant em número e sem contextInfo: contextInfo segue null', async () => {
  const { stored } = await storedAndSent('group-pn-participant', {})
  assert.equal(stored, null)
})

test('contextInfo: LID repetido nas menções é consultado uma vez; muitas menções funcionam', async () => {
  const seen = []
  const resolvePn = async (lid) => (seen.push(lid), lid === PEER_LID ? PEER_PN : null)
  const many = Array.from({ length: 45 }, (_, i) => `${100000000000000 + i}@lid`)
  const ctx = { mentionedJid: [PEER_LID, OTHER_PN, PEER_LID, ...many] }
  const out = await normalizeContextInfoAddressing(ctx, { resolvePn, ownJids })
  assert.equal(seen.filter((lid) => lid === PEER_LID).length, 1)
  assert.equal(seen.length, 46)
  assert.deepEqual(out.mentionedJid.slice(0, 3), [PEER_PN, OTHER_PN, PEER_PN])
  assert.deepEqual(out.mentionedJidAlt.slice(0, 3), [PEER_LID, null, PEER_LID])
  assert.equal(out.mentionedJidAlt.length, ctx.mentionedJid.length)
})
