import { afterCommit } from './db.js'

// Webhooks por instância (wa_webhooks) e a entrada do outbox
// (wa_webhook_deliveries). As funções puras do topo validam e filtram; o
// createWebhookService faz o acesso ao banco.

// Eventos de configuração, no nome da Evolution (o envelope usa a forma
// minúscula com ponto — ver eventName em webhookDispatcher.js).
export const WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'SEND_MESSAGE',
  'MESSAGES_UPDATE',
  'MESSAGES_EDITED',
  'MESSAGES_DELETE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED'
]

// Valores de cabeçalho nunca voltam na leitura (podem ser token do
// receptor). A tela reenvia a máscara quando o usuário não mexe no valor.
export const HEADER_MASK = '••••'

export const MAX_WEBHOOKS_PER_SESSION = 10
const MAX_URL_LENGTH = 2048
const MAX_HEADERS = 20
const MAX_HEADER_NAME_LENGTH = 256
const MAX_HEADER_VALUE_LENGTH = 8192
// "token" da RFC 9110: o que o fetch aceita como nome de cabeçalho.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// Controlados pelo próprio fetch; personalizá-los quebraria a requisição.
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])
// O fetch só aceita bytes (Latin-1) em valor de cabeçalho. Um "•" ou acento
// passaria aqui e falharia em TODA tentativa de entrega depois.
const LATIN1 = /^[\x20-\x7e\x80-\xff\t]*$/
const BOOLEAN_FIELDS = { enabled: true, base64: false, byEvents: false, includeFromMe: false }

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Valida o corpo de POST/PUT /webhooks. Retorna { value } com os defaults
 * aplicados, ou { error } com uma mensagem em português pra resposta 400.
 */
export function validateWebhookInput(body) {
  if (!isPlainObject(body)) return { error: 'corpo inválido: envie um objeto JSON com pelo menos "url"' }

  const { url } = body
  if (typeof url !== 'string' || url.trim() === '') return { error: 'informe "url" (http ou https)' }
  if (url.length > MAX_URL_LENGTH) return { error: `"url" pode ter no máximo ${MAX_URL_LENGTH} caracteres` }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { error: '"url" inválida: use uma URL completa, ex: https://exemplo.com/webhook' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: '"url" precisa usar http ou https' }
  }
  // O fetch recusa URL com usuário/senha, e a mensagem de erro dele repete a
  // URL inteira. Credencial vai em "headers" (ex.: Authorization).
  if (parsed.username || parsed.password) {
    return { error: '"url" não pode ter usuário/senha; use "headers" (ex: Authorization) para autenticar' }
  }

  let events = body.events
  if (events === undefined || events === null) events = []
  if (!Array.isArray(events)) return { error: '"events" precisa ser um array de nomes de evento' }
  const unknown = events.filter((event) => !WEBHOOK_EVENTS.includes(event))
  if (unknown.length) {
    return { error: `evento(s) desconhecido(s) em "events": ${unknown.join(', ')}. Use: ${WEBHOOK_EVENTS.join(', ')}` }
  }
  events = events.length ? [...new Set(events)] : ['MESSAGES_UPSERT']

  const value = { url, events, headers: {} }
  for (const [field, fallback] of Object.entries(BOOLEAN_FIELDS)) {
    const raw = body[field]
    if (raw === undefined) value[field] = fallback
    else if (typeof raw !== 'boolean') return { error: `"${field}" precisa ser booleano (true ou false)` }
    else value[field] = raw
  }

  const headers = body.headers ?? {}
  if (!isPlainObject(headers)) return { error: '"headers" precisa ser um objeto { "Nome": "valor" }' }
  const entries = Object.entries(headers)
  if (entries.length > MAX_HEADERS) return { error: `"headers" aceita no máximo ${MAX_HEADERS} cabeçalhos` }
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME.test(name) || name.length > MAX_HEADER_NAME_LENGTH) {
      return { error: `nome de cabeçalho inválido em "headers": "${name.slice(0, 80)}"` }
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) return { error: `o cabeçalho "${name}" não pode ser personalizado` }
    if (typeof headerValue !== 'string') return { error: `o valor do cabeçalho "${name}" precisa ser texto` }
    if (/[\r\n\0]/.test(headerValue)) return { error: `o valor do cabeçalho "${name}" não pode ter quebra de linha` }
    if (headerValue.length > MAX_HEADER_VALUE_LENGTH) {
      return { error: `o valor do cabeçalho "${name}" pode ter no máximo ${MAX_HEADER_VALUE_LENGTH} caracteres` }
    }
    // Prefixo reservado do valor cifrado (secrets.js): aceitar isso de fora
    // faria o valor ser gravado como se já estivesse cifrado.
    if (headerValue.startsWith('enc:v1:')) {
      return { error: `o valor do cabeçalho "${name}" não pode começar com "enc:v1:"` }
    }
    if (headerValue !== HEADER_MASK && !LATIN1.test(headerValue)) {
      return { error: `o valor do cabeçalho "${name}" tem caractere não suportado (use só ASCII/Latin-1)` }
    }
  }
  value.headers = Object.fromEntries(entries)

  // Ordem fixa das chaves, pra resposta e testes ficarem previsíveis.
  return {
    value: {
      url: value.url,
      enabled: value.enabled,
      events: value.events,
      base64: value.base64,
      byEvents: value.byEvents,
      includeFromMe: value.includeFromMe,
      headers: value.headers
    }
  }
}

export function maskHeaders(headers) {
  return Object.fromEntries(Object.keys(headers ?? {}).map((name) => [name, HEADER_MASK]))
}

/**
 * Substituição completa dos cabeçalhos no PUT, exceto onde chegou a máscara:
 * ali vale o valor já salvo (a tela nunca conhece o valor real). Máscara sem
 * valor salvo correspondente é descartada.
 */
export function mergeHeaders(incoming, saved) {
  const out = {}
  for (const [name, value] of Object.entries(incoming ?? {})) {
    if (value !== HEADER_MASK) out[name] = value
    else if (saved && Object.hasOwn(saved, name)) out[name] = saved[name]
  }
  return out
}

/**
 * Quais webhooks recebem um evento. Regra anti-eco (research R4):
 * MESSAGES_UPSERT de mensagem enviada pela API nunca sai (ela vai só como
 * SEND_MESSAGE), e a do próprio número em outro aparelho só vai pra quem
 * pediu includeFromMe.
 */
export function selectTargets(webhooks, event, origin) {
  return webhooks.filter((webhook) => {
    if (!webhook.enabled || !webhook.events.includes(event)) return false
    if (event === 'MESSAGES_UPSERT') {
      if (origin === 'api') return false
      if (origin === 'device') return webhook.includeFromMe
    }
    return true
  })
}

function toWebhook(row) {
  return {
    id: row.id,
    url: row.url,
    enabled: row.enabled,
    events: row.events,
    base64: row.base64,
    byEvents: row.by_events,
    includeFromMe: row.include_from_me,
    headers: maskHeaders(row.headers),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDelivery: row.ld_status
      ? { status: row.ld_status, statusCode: row.ld_status_code ?? null, at: row.ld_at }
      : null
  }
}

function toDelivery(row) {
  return {
    id: Number(row.id),
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    nextAttemptAt: row.status === 'pending' ? row.next_attempt_at : null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    messageKeyId: row.message_key_id ?? null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Webhook com a última entrega (pra situação na tela).
const SELECT_WITH_LAST_DELIVERY = `
  SELECT w.*, ld.status AS ld_status, ld.last_status_code AS ld_status_code,
         COALESCE(ld.delivered_at, ld.created_at) AS ld_at
    FROM wa_webhooks w
    LEFT JOIN LATERAL (
      SELECT status, last_status_code, delivered_at, created_at
        FROM wa_webhook_deliveries d
       WHERE d.webhook_id = w.id
       ORDER BY d.id DESC
       LIMIT 1
    ) ld ON true`

/**
 * Acesso ao banco dos webhooks. onEnqueue é chamado depois do COMMIT de cada
 * transação que criou entregas (o server.js liga isso ao dispatcher.wake()).
 * cipher (secrets.js) cifra os valores dos cabeçalhos antes de gravar; quem
 * decifra é o dispatcher, na hora do envio.
 */
export function createWebhookService({ pool, cipher, onEnqueue = () => {} }) {
  if (!cipher) throw new Error('createWebhookService: informe o cipher dos cabeçalhos (secrets.js)')
  const storeHeaders = (headers) => JSON.stringify(cipher.encryptHeaders(headers))

  // Cache dos webhooks ATIVOS por sessão: o enqueue roda a cada mensagem e
  // não deve consultar o banco toda vez. Processo único: toda escrita passa
  // por aqui e invalida a sessão. Guarda a Promise pra consultas
  // concorrentes não irem todas ao banco.
  const activeCache = new Map()

  function invalidate(sessionId) {
    activeCache.delete(sessionId)
  }

  // `db` é o client da transação em andamento (ou o pool). Consultar pelo
  // pool de dentro de uma transação pede uma 2ª conexão enquanto a 1ª fica
  // presa: com muitas mensagens simultâneas e o cache vazio (boot), todas as
  // conexões do pool esperariam umas pelas outras.
  function activeWebhooks(sessionId, db = pool) {
    let cached = activeCache.get(sessionId)
    if (!cached) {
      cached = db
        .query(
          `SELECT id, enabled, events, include_from_me FROM wa_webhooks WHERE session_id = $1 AND enabled ORDER BY created_at`,
          [sessionId]
        )
        .then(({ rows }) => rows.map((row) => ({ id: row.id, enabled: row.enabled, events: row.events, includeFromMe: row.include_from_me })))
      cached.catch(() => activeCache.delete(sessionId))
      activeCache.set(sessionId, cached)
    }
    return cached
  }

  async function listWebhooks(sessionId) {
    const { rows } = await pool.query(`${SELECT_WITH_LAST_DELIVERY} WHERE w.session_id = $1 ORDER BY w.created_at`, [sessionId])
    return rows.map(toWebhook)
  }

  async function getWebhook(sessionId, webhookId) {
    if (!UUID.test(webhookId)) return null
    const { rows } = await pool.query(`${SELECT_WITH_LAST_DELIVERY} WHERE w.session_id = $1 AND w.id = $2`, [sessionId, webhookId])
    return rows[0] ? toWebhook(rows[0]) : null
  }

  // Linha crua (cabeçalhos ainda cifrados) — só pra uso interno (teste de envio).
  async function getWebhookRaw(sessionId, webhookId) {
    if (!UUID.test(webhookId)) return null
    const { rows } = await pool.query('SELECT * FROM wa_webhooks WHERE session_id = $1 AND id = $2', [sessionId, webhookId])
    return rows[0] ?? null
  }

  /** Retorna { webhook } ou { error } (limite de webhooks por instância). */
  async function createWebhook(sessionId, value) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Trava a linha da sessão: dois POSTs simultâneos não passam juntos do limite.
      await client.query('SELECT id FROM wa_sessions WHERE id = $1 FOR UPDATE', [sessionId])
      const {
        rows: [{ n }]
      } = await client.query('SELECT count(*)::int AS n FROM wa_webhooks WHERE session_id = $1', [sessionId])
      if (n >= MAX_WEBHOOKS_PER_SESSION) {
        await client.query('ROLLBACK')
        return { error: `limite de ${MAX_WEBHOOKS_PER_SESSION} webhooks por instância atingido` }
      }
      const {
        rows: [row]
      } = await client.query(
        `INSERT INTO wa_webhooks (session_id, url, enabled, events, base64, by_events, include_from_me, headers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          sessionId,
          value.url,
          value.enabled,
          value.events,
          value.base64,
          value.byEvents,
          value.includeFromMe,
          storeHeaders(mergeHeaders(value.headers, {}))
        ]
      )
      await client.query('COMMIT')
      invalidate(sessionId)
      return { webhook: toWebhook(row) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Substituição completa. Retorna { webhook }, { error } (400) ou null se não for desta sessão. */
  async function updateWebhook(sessionId, webhookId, value) {
    const saved = await getWebhookRaw(sessionId, webhookId)
    if (!saved) return null
    // A máscara só preserva o valor salvo se o destino continuar o mesmo:
    // senão bastaria trocar a URL por um servidor próprio, mandar "••••" e o
    // token do receptor original passaria a ser enviado pra lá.
    // Em vez de descartar a máscara em silêncio (o webhook perderia o token
    // sem aviso), recusa e pede o valor de novo.
    const sameOrigin = new URL(saved.url).origin === new URL(value.url).origin
    const masked = Object.entries(value.headers).filter(([, v]) => v === HEADER_MASK).map(([name]) => name)
    if (!sameOrigin && masked.length) {
      return {
        error: `a URL mudou de destino: informe de novo o valor de ${masked.map((n) => `"${n}"`).join(', ')} (o valor salvo não é reaproveitado para outro host)`
      }
    }
    const { rowCount } = await pool.query(
      `UPDATE wa_webhooks
          SET url = $3, enabled = $4, events = $5, base64 = $6, by_events = $7, include_from_me = $8,
              headers = $9::jsonb, updated_at = now()
        WHERE session_id = $1 AND id = $2`,
      [
        sessionId,
        webhookId,
        value.url,
        value.enabled,
        value.events,
        value.base64,
        value.byEvents,
        value.includeFromMe,
        // O valor salvo reaproveitado pela máscara já está cifrado e passa
        // direto; só os valores novos são cifrados aqui.
        storeHeaders(mergeHeaders(value.headers, saved.headers))
      ]
    )
    invalidate(sessionId)
    return rowCount ? { webhook: await getWebhook(sessionId, webhookId) } : null
  }

  /**
   * Cifra cabeçalhos gravados em texto puro (webhooks criados antes da cifra
   * existir). Roda no boot; idempotente. Retorna quantos webhooks mudaram.
   */
  async function encryptLegacyHeaders() {
    const { rows } = await pool.query(`SELECT id, headers FROM wa_webhooks WHERE headers <> '{}'::jsonb`)
    let changed = 0
    for (const row of rows) {
      if (!cipher.hasPlaintext(row.headers)) continue
      await pool.query('UPDATE wa_webhooks SET headers = $2::jsonb WHERE id = $1', [row.id, storeHeaders(row.headers)])
      changed++
    }
    return changed
  }

  /** As entregas pendentes vão junto (ON DELETE CASCADE). */
  async function deleteWebhook(sessionId, webhookId) {
    if (!UUID.test(webhookId)) return false
    const { rowCount } = await pool.query('DELETE FROM wa_webhooks WHERE session_id = $1 AND id = $2', [sessionId, webhookId])
    invalidate(sessionId)
    return rowCount > 0
  }

  async function listDeliveries(webhookId, { status = null, limit = 50, before = null } = {}) {
    const { rows } = await pool.query(
      `SELECT d.id, d.event, d.status, d.attempts, d.last_status_code, d.last_error, d.next_attempt_at,
              d.created_at, d.delivered_at, m.key_id AS message_key_id
         FROM wa_webhook_deliveries d
         LEFT JOIN wa_messages m ON m.id = d.message_id
        WHERE d.webhook_id = $1
          AND ($2::text IS NULL OR d.status = $2)
          AND ($3::bigint IS NULL OR d.id < $3)
        ORDER BY d.id DESC
        LIMIT $4`,
      [webhookId, status, before, limit + 1]
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return { items: page.map(toDelivery), nextBefore: hasMore ? Number(page[page.length - 1].id) : null }
  }

  /**
   * Cria uma entrega por webhook alvo, dentro da transação do client (a mesma
   * que gravou a mensagem). O payload é o "data" do envelope, sem base64. O
   * dispatcher só é acordado depois do COMMIT. Retorna quantas entregas criou.
   */
  async function enqueue(client, sessionId, event, payload, { messageId = null, origin } = {}) {
    const targets = selectTargets(await activeWebhooks(sessionId, client), event, origin)
    let created = 0
    for (const webhook of targets) {
      // INSERT ... SELECT em vez de VALUES: se o cache estiver um instante
      // desatualizado (webhook acabou de ser excluído/desativado), não insere
      // nada — com VALUES, a FK derrubaria a transação e a mensagem junto.
      const { rowCount } = await client.query(
        `INSERT INTO wa_webhook_deliveries (webhook_id, session_id, event, message_id, payload)
         SELECT id, $2, $3, $4, $5::jsonb FROM wa_webhooks WHERE id = $1 AND enabled`,
        [webhook.id, sessionId, event, messageId, JSON.stringify(payload)]
      )
      created += rowCount
    }
    if (created) afterCommit(client, onEnqueue)
    return created
  }

  return {
    invalidate,
    encryptLegacyHeaders,
    listWebhooks,
    getWebhook,
    getWebhookRaw,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    listDeliveries,
    enqueue
  }
}
