import { pool, withTransaction } from './db.js'

// Persistência das mensagens (wa_messages). A gravação e a criação das
// entregas de webhook acontecem na MESMA transação, via os ganchos onInserted
// / onApplied / onUpdated: se o processo cair no meio, ou a mensagem e os
// avisos existem juntos, ou nenhum dos dois.

// Ordem de avanço do status (enum do Baileys). ERROR, EDITED e DELETED ficam
// fora da ordem: são aceitos a qualquer momento.
const STATUS_ORDER = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED']
const ALWAYS_ACCEPTED = new Set(['ERROR', 'EDITED', 'DELETED'])
const TERMINAL = new Set(['EDITED', 'DELETED'])

/** Linha de wa_messages → "data" do contrato (formato messages.upsert) + origin. */
export function rowToData(row) {
  return {
    key: row.key,
    pushName: row.push_name,
    status: row.status,
    message: row.message,
    contextInfo: row.context_info,
    messageType: row.message_type,
    messageTimestamp: Number(row.message_timestamp),
    instanceId: row.session_id,
    source: row.source,
    origin: row.origin
  }
}

/** "data" do webhook: o mesmo do histórico, sem o origin (que a Evolution não tem). */
export function webhookDataFromRow(row) {
  const { origin, ...data } = rowToData(row)
  return data
}

/**
 * Status só avança (READ não volta pra DELIVERY_ACK quando os recibos chegam
 * fora de ordem). ERROR, EDITED e DELETED sempre entram; uma mensagem editada
 * ou apagada não volta a mostrar recibo de leitura por cima disso.
 */
export function canAdvanceStatus(from, to) {
  if (!to || from === to) return false
  if (ALWAYS_ACCEPTED.has(to)) return true
  if (TERMINAL.has(from)) return false
  if (!from) return true
  return STATUS_ORDER.indexOf(to) > STATUS_ORDER.indexOf(from)
}

/**
 * Aplica o conteúdo editado sobre o original. Edição de legenda chega só com
 * o campo alterado (ex.: { imageMessage: { caption } }), então o conteúdo do
 * mesmo tipo é mesclado em vez de substituído — senão a mídia se perderia.
 */
export function mergeEditedMessage(original, edited) {
  if (!edited) return original
  const out = { ...original }
  for (const [type, value] of Object.entries(edited)) {
    const previous = original?.[type]
    out[type] =
      value && typeof value === 'object' && previous && typeof previous === 'object' ? { ...previous, ...value } : value
  }
  return out
}

/**
 * Grava a mensagem uma única vez. Retorna a linha inserida, ou null se ela já
 * existia (reentrega do Baileys ou eco de envio pela API já gravado). Só quem
 * insere chama onInserted — é isso que garante um aviso por mensagem.
 */
export async function saveMessage(sessionId, data, origin, { onInserted } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO wa_messages (session_id, key_id, remote_jid, remote_jid_alt, participant, from_me, origin,
                                push_name, message_type, key, message, context_info, message_timestamp, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15)
       ON CONFLICT (session_id, key_id, from_me) DO NOTHING
       RETURNING *`,
      [
        sessionId,
        data.key.id,
        data.key.remoteJid,
        data.key.remoteJidAlt ?? null,
        data.key.participant ?? null,
        Boolean(data.key.fromMe),
        origin,
        data.pushName ?? null,
        data.messageType,
        JSON.stringify(data.key),
        JSON.stringify(data.message ?? {}),
        data.contextInfo ? JSON.stringify(data.contextInfo) : null,
        data.messageTimestamp ?? Math.floor(Date.now() / 1000),
        data.status ?? null,
        data.source ?? null
      ]
    )
    const row = rows[0] ?? null
    if (row) await onInserted?.(client, row)
    return row
  })
}

/**
 * Edição (MESSAGE_EDIT) ou exclusão (REVOKE) sobre a mensagem original,
 * localizada pelo key_id (o fromMe do protocolMessage é do ponto de vista de
 * quem editou, então não serve pra casar com a nossa linha).
 *
 * onApplied(client, row) roda na mesma transação; row é null se a original
 * não foi gravada (ex.: chegou antes desta bridge receber mensagens) — nesse
 * caso o evento sai mesmo assim. Se a original já estava nesse estado
 * (reentrega do mesmo protocolMessage), nada muda e onApplied não é chamado.
 */
export async function applyProtocol(sessionId, protocol, { onApplied } = {}) {
  return withTransaction(async (client) => {
    const {
      rows: [original]
    } = await client.query(
      `SELECT * FROM wa_messages WHERE session_id = $1 AND key_id = $2 ORDER BY from_me LIMIT 1 FOR UPDATE`,
      [sessionId, protocol.key.id]
    )

    if (!original) {
      await onApplied?.(client, null)
      return null
    }

    let updated
    if (protocol.type === 'MESSAGE_EDIT') {
      const message = mergeEditedMessage(original.message, protocol.editedMessage)
      if (original.status === 'EDITED' && JSON.stringify(message) === JSON.stringify(original.message)) return original
      ;({
        rows: [updated]
      } = await client.query(
        `UPDATE wa_messages SET message = $2::jsonb, status = 'EDITED', updated_at = now() WHERE id = $1 RETURNING *`,
        [original.id, JSON.stringify(message)]
      ))
    } else {
      if (original.status === 'DELETED') return original
      ;({
        rows: [updated]
      } = await client.query(
        `UPDATE wa_messages SET status = 'DELETED', updated_at = now() WHERE id = $1 RETURNING *`,
        [original.id]
      ))
    }

    await onApplied?.(client, updated)
    return updated
  })
}

/**
 * Atualiza o status (messages.update) só se for avanço. Retorna a linha
 * atualizada ou null (mensagem desconhecida ou status que não avança).
 */
export async function updateStatus(sessionId, keyId, fromMe, status, { onUpdated } = {}) {
  return withTransaction(async (client) => {
    const {
      rows: [current]
    } = await client.query(
      `SELECT id, status FROM wa_messages WHERE session_id = $1 AND key_id = $2 AND from_me = $3 FOR UPDATE`,
      [sessionId, keyId, Boolean(fromMe)]
    )
    if (!current || !canAdvanceStatus(current.status, status)) return null

    const {
      rows: [row]
    } = await client.query(`UPDATE wa_messages SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`, [
      current.id,
      status
    ])
    await onUpdated?.(client, row)
    return row
  })
}

/** Histórico, do mais novo pro mais antigo, paginado por id. */
export async function listMessages(sessionId, { remoteJid = null, limit = 50, before = null } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM wa_messages
     WHERE session_id = $1
       AND ($2::text IS NULL OR remote_jid = $2 OR remote_jid_alt = $2)
       AND ($3::bigint IS NULL OR id < $3)
     ORDER BY id DESC
     LIMIT $4`,
    [sessionId, remoteJid, before, limit + 1]
  )
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    items: page.map(rowToData),
    nextBefore: hasMore ? Number(page[page.length - 1].id) : null
  }
}

const PURGE_BATCH = 5000

/**
 * Apaga mensagens gravadas há mais de `days` dias (MESSAGE_RETENTION_DAYS).
 * Em lotes curtos, pra não segurar lock da tabela inteira nem competir com a
 * gravação das mensagens que estão chegando. Retorna quantas apagou.
 */
export async function purgeOldMessages(days) {
  let total = 0
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM wa_messages
        WHERE id IN (SELECT id FROM wa_messages WHERE created_at < now() - make_interval(days => $1) ORDER BY id LIMIT $2)`,
      [days, PURGE_BATCH]
    )
    total += rowCount
    if (rowCount < PURGE_BATCH) return total
  }
}

/** Mensagem gravada pelo key.id (qualquer fromMe), ou null. */
export async function findMessageByKeyId(sessionId, keyId) {
  const {
    rows: [row]
  } = await pool.query(`SELECT * FROM wa_messages WHERE session_id = $1 AND key_id = $2 ORDER BY from_me LIMIT 1`, [
    sessionId,
    keyId
  ])
  return row ?? null
}
