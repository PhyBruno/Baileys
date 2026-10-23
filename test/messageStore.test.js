import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowToData, webhookDataFromRow, canAdvanceStatus, mergeEditedMessage } from '../messageStore.js'

// Linha sintética como o pg devolve (BIGINT vem como string).
const row = {
  id: '4821',
  session_id: '5511900000001',
  key_id: '3EB0A1B2C3D4E5F60718',
  remote_jid: '5511988887777@s.whatsapp.net',
  remote_jid_alt: '123456789012345@lid',
  participant: null,
  from_me: false,
  origin: 'inbound',
  push_name: 'Maria Exemplo',
  message_type: 'conversation',
  key: { remoteJid: '5511988887777@s.whatsapp.net', remoteJidAlt: '123456789012345@lid', addressingMode: 'pn', fromMe: false, id: '3EB0A1B2C3D4E5F60718' },
  message: { conversation: 'Olá' },
  context_info: null,
  message_timestamp: '1792750000',
  status: 'DELIVERY_ACK',
  source: 'android',
  created_at: new Date(),
  updated_at: new Date()
}

test('rowToData remonta o data do contrato + origin', () => {
  assert.deepEqual(rowToData(row), {
    key: row.key,
    pushName: 'Maria Exemplo',
    status: 'DELIVERY_ACK',
    message: { conversation: 'Olá' },
    contextInfo: null,
    messageType: 'conversation',
    messageTimestamp: 1792750000,
    instanceId: '5511900000001',
    source: 'android',
    origin: 'inbound'
  })
})

test('webhookDataFromRow é o data sem o origin (campo só do histórico)', () => {
  const data = webhookDataFromRow(row)
  assert.equal('origin' in data, false)
  assert.equal(data.messageTimestamp, 1792750000)
})

test('canAdvanceStatus só avança na ordem ERROR < PENDING < SERVER_ACK < DELIVERY_ACK < READ < PLAYED', () => {
  assert.equal(canAdvanceStatus('PENDING', 'SERVER_ACK'), true)
  assert.equal(canAdvanceStatus('SERVER_ACK', 'DELIVERY_ACK'), true)
  assert.equal(canAdvanceStatus('DELIVERY_ACK', 'READ'), true)
  assert.equal(canAdvanceStatus('READ', 'PLAYED'), true)
  assert.equal(canAdvanceStatus('PENDING', 'READ'), true, 'pode pular etapas')
  assert.equal(canAdvanceStatus(null, 'DELIVERY_ACK'), true, 'sem status ainda')
  assert.equal(canAdvanceStatus('ERROR', 'SERVER_ACK'), true)
})

test('canAdvanceStatus nunca regride nem repete', () => {
  assert.equal(canAdvanceStatus('READ', 'DELIVERY_ACK'), false)
  assert.equal(canAdvanceStatus('PLAYED', 'READ'), false)
  assert.equal(canAdvanceStatus('SERVER_ACK', 'PENDING'), false)
  assert.equal(canAdvanceStatus('READ', 'READ'), false)
})

test('canAdvanceStatus sempre aceita ERROR, EDITED e DELETED', () => {
  assert.equal(canAdvanceStatus('PLAYED', 'ERROR'), true)
  assert.equal(canAdvanceStatus('READ', 'EDITED'), true)
  assert.equal(canAdvanceStatus('EDITED', 'DELETED'), true)
  assert.equal(canAdvanceStatus(null, 'DELETED'), true)
})

test('canAdvanceStatus não tira uma mensagem de EDITED/DELETED por recibo de leitura', () => {
  assert.equal(canAdvanceStatus('DELETED', 'READ'), false)
  assert.equal(canAdvanceStatus('EDITED', 'READ'), false)
  assert.equal(canAdvanceStatus('DELETED', 'DELETED'), false)
})

test('mergeEditedMessage troca o texto e preserva a mídia ao editar legenda', () => {
  assert.deepEqual(mergeEditedMessage({ conversation: 'antigo' }, { conversation: 'novo' }), { conversation: 'novo' })
  const image = { imageMessage: { url: 'u', mediaKey: 'k', caption: 'antiga' } }
  assert.deepEqual(mergeEditedMessage(image, { imageMessage: { caption: 'nova' } }), {
    imageMessage: { url: 'u', mediaKey: 'k', caption: 'nova' }
  })
})
