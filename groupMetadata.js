import { isJidGroup } from 'baileys'

// Nome dos grupos (subject), pros webhooks (data.groupSubject) e pro
// histórico. Busca em três camadas, nesta ordem:
//   L1 — memória por sessão (TTL, teto de grupos, descarta o mais antigo);
//   L2 — wa_groups no Postgres, uma consulta por lote (nunca uma por mensagem);
//   L3 — sock.groupMetadata(jid) no WhatsApp, só quando L1 e L2 não têm.
//
// L3 é caro e o WhatsApp limita (rate-overlimit): uma consulta por grupo de
// cada vez (single-flight), poucas simultâneas por sessão, timeout e cache
// negativo pra não insistir num grupo que falhou. Todo resultado de L3 e todo
// groups.upsert/groups.update grava em L2 e atualiza L1 (write-through).
//
// Nada aqui lança: erro, timeout ou sessão sem socket conectado viram null, e
// quem chama (entrega de webhook, histórico) segue normalmente. O nome é dado
// do usuário: os logs mostram só o JID e o resultado, nunca o subject.

export const GROUP_METADATA_DEFAULTS = {
  ttlMs: 21_600_000,
  failureTtlMs: 300_000,
  timeoutMs: 3_000,
  maxEntries: 2_000,
  maxConcurrent: 3
}

const TIMEOUT = Symbol('timeout')

function withTimeout(promise, ms, fallback = TIMEOUT) {
  let timer
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(ms, 0))
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

/** remote_jid de grupo distintos de uma lista de itens "data", na ordem em que aparecem. */
export function distinctGroupJids(items) {
  return [...new Set(items.map((item) => item?.key?.remoteJid).filter((jid) => isJidGroup(jid)))]
}

/** Acrescenta groupSubject (string | null) só aos itens de grupo. Não altera os itens recebidos. */
export function withGroupSubjects(items, subjects) {
  return items.map((item) =>
    isJidGroup(item?.key?.remoteJid) ? { ...item, groupSubject: subjects.get(item.key.remoteJid) ?? null } : item
  )
}

/**
 * pool:      pg Pool (wa_groups)
 * getSocket: (sessionId) → socket CONECTADO ou undefined (sem socket, só L1 e L2)
 * config:    { ttlMs, failureTtlMs, timeoutMs, maxEntries, maxConcurrent }
 */
export function createGroupMetadataCache({ pool, getSocket = () => undefined, config = {}, log = console, now = Date.now }) {
  const { ttlMs, failureTtlMs, timeoutMs, maxEntries, maxConcurrent } = { ...GROUP_METADATA_DEFAULTS, ...config }
  const debug = log.debug?.bind(log) ?? (() => {})

  // sessionId → Map<jid, { subject, metadata, expiresAt }>. metadata é o
  // GroupMetadata completo (L3 ou groups.upsert), servido ao Baileys pelo
  // cachedGroupMetadata; do L2 só vem o subject.
  const memory = new Map()
  // "<sessionId> <jid>" → validade do cache negativo (L3 falhou)
  const failures = new Map()
  // "<sessionId> <jid>" → Promise<string | null> da consulta L3 em andamento
  const flights = new Map()
  // sessionId → { active, queue } — limite de consultas L3 simultâneas
  const slots = new Map()

  const flightId = (sessionId, jid) => `${sessionId} ${jid}`

  function remember(sessionId, jid, subject, metadata) {
    let groups = memory.get(sessionId)
    if (!groups) memory.set(sessionId, (groups = new Map()))
    const previous = groups.get(jid)
    // delete + set: o grupo vai pro fim da ordem de inserção (mais novo).
    groups.delete(jid)
    groups.set(jid, {
      subject,
      metadata: metadata === undefined ? (previous?.metadata ?? null) : metadata,
      expiresAt: now() + ttlMs
    })
    while (groups.size > maxEntries) groups.delete(groups.keys().next().value)
  }

  function fromMemory(sessionId, jid) {
    const groups = memory.get(sessionId)
    const hit = groups?.get(jid)
    if (!hit) return undefined
    if (hit.expiresAt <= now()) {
      groups.delete(jid)
      return undefined
    }
    return hit
  }

  function recentlyFailed(id) {
    const until = failures.get(id)
    if (until === undefined) return false
    if (until > now()) return true
    failures.delete(id)
    return false
  }

  async function fromDatabase(sessionId, jids) {
    const { rows } = await pool.query('SELECT jid, subject FROM wa_groups WHERE session_id = $1 AND jid = ANY($2::text[])', [
      sessionId,
      jids
    ])
    return new Map(rows.filter((row) => typeof row.subject === 'string').map((row) => [row.jid, row.subject]))
  }

  async function persist(sessionId, subjects) {
    if (subjects.size === 0) return
    try {
      // Um INSERT só pro lote; a Map já deixou um nome por grupo (repetido no
      // mesmo comando, o ON CONFLICT DO UPDATE falharia).
      await pool.query(
        `INSERT INTO wa_groups (session_id, jid, subject)
         SELECT $1, jid, subject FROM unnest($2::text[], $3::text[]) AS t(jid, subject)
         ON CONFLICT (session_id, jid) DO UPDATE SET subject = EXCLUDED.subject, updated_at = now()`,
        [sessionId, [...subjects.keys()], [...subjects.values()]]
      )
    } catch (err) {
      log.warn(`[${sessionId}] grupos: falha ao gravar ${subjects.size} nome(s) em wa_groups: ${err.message}`)
    }
  }

  function learn(sessionId, jid, metadata) {
    if (typeof metadata?.subject !== 'string') return false
    remember(sessionId, jid, metadata.subject, Array.isArray(metadata.participants) ? metadata : null)
    failures.delete(flightId(sessionId, jid))
    persist(sessionId, new Map([[jid, metadata.subject]]))
    return true
  }

  function acquire(sessionId) {
    let slot = slots.get(sessionId)
    if (!slot) slots.set(sessionId, (slot = { active: 0, queue: [] }))
    if (slot.active < maxConcurrent) {
      slot.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => slot.queue.push(resolve))
  }

  function release(sessionId) {
    const slot = slots.get(sessionId)
    const next = slot.queue.shift()
    if (next) next() // a vaga passa direto pro próximo da fila
    else if (--slot.active === 0) slots.delete(sessionId)
  }

  // L3, single-flight: pedidos simultâneos do mesmo grupo esperam a mesma
  // consulta. A vaga fica presa no máximo timeoutMs; uma resposta que chega
  // depois disso ainda é gravada (a próxima entrega acha no L1/L2).
  function lookup(sessionId, jid, sock) {
    const id = flightId(sessionId, jid)
    let flight = flights.get(id)
    if (flight) return flight

    flight = (async () => {
      await acquire(sessionId)
      try {
        // Pode ter chegado por groups.update enquanto esperava a vaga.
        const cached = fromMemory(sessionId, jid)
        if (cached) return cached.subject

        const query = Promise.resolve().then(() => sock.groupMetadata(jid))
        const result = await withTimeout(
          query.then(
            (metadata) => ({ metadata }),
            (error) => ({ error })
          ),
          timeoutMs
        )

        if (result === TIMEOUT) {
          failures.set(id, now() + failureTtlMs)
          log.warn(`[${sessionId}] grupo ${jid}: WhatsApp não respondeu em ${timeoutMs}ms — nome fica null por ${failureTtlMs}ms`)
          query.then((metadata) => learn(sessionId, jid, metadata)).catch(() => {})
          return null
        }
        // rate-overlimit, grupo inexistente, sem permissão... tudo conta como falha.
        if (result.error || !learn(sessionId, jid, result.metadata)) {
          failures.set(id, now() + failureTtlMs)
          const reason = result.error ? result.error.message : 'resposta sem subject'
          log.warn(`[${sessionId}] grupo ${jid}: consulta ao WhatsApp falhou (${reason}) — nome fica null por ${failureTtlMs}ms`)
          return null
        }
        log.info(`[${sessionId}] grupo ${jid}: nome obtido do WhatsApp`)
        return result.metadata.subject
      } finally {
        release(sessionId)
        flights.delete(id)
      }
    })()
    flights.set(id, flight)
    return flight
  }

  /**
   * Nomes de vários grupos de uma vez: L1, depois UMA consulta ao L2 com os
   * que faltaram, depois L3 em paralelo (limitado por sessão) pro resto.
   * Retorna Map<jid, string | null> com todos os JIDs de grupo pedidos.
   *
   * options.maxLookups: máximo de consultas L3 iniciadas nesta chamada
   * options.budgetMs:   tempo total da chamada; sem ele, cada consulta L3
   *                     espera até timeoutMs
   */
  async function resolveSubjects(sessionId, jids, { maxLookups = Infinity, budgetMs = null } = {}) {
    const started = now()
    const result = new Map()
    const wanted = [...new Set(jids)].filter((jid) => isJidGroup(jid))
    for (const jid of wanted) result.set(jid, null)

    try {
      const missing = []
      for (const jid of wanted) {
        const hit = fromMemory(sessionId, jid)
        if (hit) {
          result.set(jid, hit.subject)
          debug(`[${sessionId}] grupo ${jid}: nome em memória (L1)`)
        } else {
          missing.push(jid)
        }
      }
      if (missing.length === 0) return result

      const stored = await fromDatabase(sessionId, missing)
      const pending = []
      for (const jid of missing) {
        if (stored.has(jid)) {
          remember(sessionId, jid, stored.get(jid))
          result.set(jid, stored.get(jid))
          debug(`[${sessionId}] grupo ${jid}: nome no banco (L2)`)
        } else {
          pending.push(jid)
        }
      }

      const sock = getSocket(sessionId)
      if (!sock || pending.length === 0) return result

      let lookups = 0
      await Promise.all(
        pending.map(async (jid) => {
          if (recentlyFailed(flightId(sessionId, jid)) || lookups >= maxLookups) return
          const wait = budgetMs === null ? timeoutMs : budgetMs - (now() - started)
          if (wait <= 0) return
          lookups++
          const subject = await withTimeout(lookup(sessionId, jid, sock), wait, null)
          result.set(jid, subject)
        })
      )
    } catch (err) {
      log.warn(`[${sessionId}] grupos: falha ao resolver ${wanted.length} nome(s): ${err.message}`)
    }
    return result
  }

  return {
    timeoutMs,

    resolveSubjects,

    /** Nome de um grupo (string | null). Nunca lança. */
    async getSubject(sessionId, jid) {
      return (await resolveSubjects(sessionId, [jid])).get(jid) ?? null
    },

    /**
     * cachedGroupMetadata do makeWASocket (Baileys 7.0.0-rc14:
     * (jid) => Promise<GroupMetadata | undefined>). Só responde da memória e
     * só com o metadata completo: sem participants o Baileys consulta o grupo
     * ele mesmo, que é o certo pra quem só tem o nome vindo do banco.
     */
    cachedGroupMetadata(sessionId) {
      return async (jid) => fromMemory(sessionId, jid)?.metadata ?? undefined
    },

    /** groups.upsert: GroupMetadata[] (entrou num grupo, ou sincronização). */
    onGroupsUpsert(sessionId, list) {
      const subjects = new Map()
      for (const metadata of list ?? []) {
        if (!metadata?.id || typeof metadata.subject !== 'string') continue
        remember(sessionId, metadata.id, metadata.subject, Array.isArray(metadata.participants) ? metadata : null)
        failures.delete(flightId(sessionId, metadata.id))
        subjects.set(metadata.id, metadata.subject)
      }
      return persist(sessionId, subjects)
    },

    /** groups.update: Partial<GroupMetadata>[] — troca o nome quando ele vem. */
    onGroupsUpdate(sessionId, updates) {
      const subjects = new Map()
      for (const update of updates ?? []) {
        if (!update?.id) continue
        const current = memory.get(sessionId)?.get(update.id)
        const metadata = current?.metadata ? { ...current.metadata, ...update } : undefined
        if (typeof update.subject === 'string') {
          remember(sessionId, update.id, update.subject, metadata)
          failures.delete(flightId(sessionId, update.id))
          subjects.set(update.id, update.subject)
        } else if (current && metadata) {
          current.metadata = metadata
        }
      }
      return persist(sessionId, subjects)
    },

    /**
     * group-participants.update: a lista de participantes em memória ficou
     * velha. Mantém o nome e descarta o metadata, pro Baileys buscar a lista
     * nova no próximo envio ao grupo.
     */
    onParticipantsUpdate(sessionId, { id } = {}) {
      const current = id ? memory.get(sessionId)?.get(id) : undefined
      if (current) current.metadata = null
    },

    /** Sessão removida: o CASCADE apaga wa_groups, aqui sai a memória. */
    forgetSession(sessionId) {
      memory.delete(sessionId)
      for (const id of failures.keys()) if (id.startsWith(`${sessionId} `)) failures.delete(id)
    }
  }
}
