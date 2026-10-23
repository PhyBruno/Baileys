import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLidJid, makePnResolver, normalizeKeyAddressing } from '../lid.js'

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
