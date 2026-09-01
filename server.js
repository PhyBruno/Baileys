import 'dotenv/config'
import crypto from 'crypto'
import express from 'express'
import QRCode from 'qrcode'
import pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from 'baileys'
import { pool, migrate } from './db.js'
import { usePostgresAuthState, wipeAuthState } from './postgresAuthState.js'

const PORT = process.env.PORT || 3000
const API_KEY = process.env.API_KEY
const logger = pino({ level: 'silent' }) // troque para 'info' se quiser ver os logs internos do baileys

if (!API_KEY) {
  console.error('ERRO: defina a variável de ambiente API_KEY antes de subir a bridge.')
  process.exit(1)
}

// Reconexão automática: quantidade de tentativas e delay entre elas, ambos
// configuráveis por ambiente. Delay FIXO (não exponencial) — cada tentativa
// espera o mesmo tempo. Só entra em ação em queda de conexão; uma desconexão
// pedida via API (/disconnect ou DELETE) nunca aciona reconexão automática.
const RECONNECT_MAX_ATTEMPTS = Number(process.env.RECONNECT_MAX_ATTEMPTS ?? 5)
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS ?? 30_000)

if (!Number.isFinite(RECONNECT_MAX_ATTEMPTS) || RECONNECT_MAX_ATTEMPTS < 0) {
  console.error('ERRO: RECONNECT_MAX_ATTEMPTS precisa ser um número >= 0.')
  process.exit(1)
}
if (!Number.isFinite(RECONNECT_DELAY_MS) || RECONNECT_DELAY_MS < 0) {
  console.error('ERRO: RECONNECT_DELAY_MS precisa ser um número >= 0.')
  process.exit(1)
}

// Tempo máximo que uma sessão pode ficar em "connecting" sem nenhum sinal de
// vida (sem virar "qr", "connected" ou nem sequer fechar com erro) antes da
// bridge forçar a desconexão sozinha. Existe porque a abertura do socket do
// baileys pode travar indefinidamente num TCP handshake que nunca completa
// nem falha (comum atrás de firewall restritivo) — isso não é coberto pelo
// connectTimeoutMs interno do baileys, que só conta a partir do WebSocket já
// aberto. É só um "force disconnect", igual ao /disconnect manual: NÃO tenta
// reconectar sozinho depois — fica em "disconnected" esperando um /connect.
// 0 desativa o watchdog.
const CONNECTING_TIMEOUT_MS = Number(process.env.CONNECTING_TIMEOUT_MS ?? 45_000)

if (!Number.isFinite(CONNECTING_TIMEOUT_MS) || CONNECTING_TIMEOUT_MS < 0) {
  console.error('ERRO: CONNECTING_TIMEOUT_MS precisa ser um número >= 0 (0 desativa o watchdog).')
  process.exit(1)
}

// Formato aceito para o ID da sessão e para o destinatário de mensagens:
// apenas dígitos, com DDI incluído (ex: 5511999999999). Nada de "+", espaço ou "-".
const NUMBER_FORMAT = /^\d{8,15}$/

// Quantas mensagens enviadas recentemente ficam guardadas em memória por
// sessão, pra atender getMessage (pedidos de retry do WhatsApp).
const MAX_CACHED_MESSAGES_PER_SESSION = 100

// fetchLatestBaileysVersion() faz uma chamada HTTP pro GitHub a cada vez que
// é chamada. Chamá-la dentro de startSession() significava refazer essa
// chamada em TODO /connect e em TODA reconexão automática (inclusive uma vez
// por sessão restaurada no boot) — desnecessário, já que a versão não muda
// no meio da execução do processo, e arriscado, já que a função não aceita
// timeout/AbortSignal: num ambiente com egress restrito (comum em deploy de
// produção que só libera os domínios do WhatsApp), uma chamada que trava sem
// nunca resolver travaria startSession() indefinidamente. Resolvemos a
// versão uma única vez no boot, com um timeout próprio, e reaproveitamos o
// resultado em toda chamada de startSession().
const BAILEYS_VERSION_FETCH_TIMEOUT_MS = 8_000
let cachedBaileysVersion = null

async function resolveBaileysVersion() {
  const timedOut = Symbol('timeout')
  const timeout = new Promise((resolve) => setTimeout(() => resolve(timedOut), BAILEYS_VERSION_FETCH_TIMEOUT_MS))
  const result = await Promise.race([fetchLatestBaileysVersion().catch(() => timedOut), timeout])
  if (result === timedOut) {
    console.warn(
      `fetchLatestBaileysVersion não respondeu em ${BAILEYS_VERSION_FETCH_TIMEOUT_MS}ms — ` +
        'seguindo com a versão embutida no pacote baileys instalado.'
    )
    return
  }
  cachedBaileysVersion = result.version
}

function normalizeNumber(raw) {
  return String(raw).replace(/\D/g, '')
}

// Estado em memória das sessões vivas neste processo.
// id -> { sock, status, qr, jid, intentionalDisconnect }
const sessions = new Map()

// Controle de tentativas de reconexão por sessão (fora do "entry" pra sobreviver
// a cada recriação de socket). id -> número de falhas consecutivas.
const reconnectAttempts = new Map()

// Handle do setTimeout de reconexão agendada por sessão. Sem isso, um /connect
// manual (ou o próprio restartRequired) podia criar uma sessão nova enquanto um
// setTimeout de uma queda anterior ainda estava pendente; quando esse timer
// disparasse mais tarde, ele criava MAIS uma sessão por cima da que já estava
// funcionando — dois sockets do Baileys vivos ao mesmo tempo com a mesma
// credencial, brigando entre si (o WhatsApp historicamente reage a isso
// derrubando um dos dois com connectionReplaced, e pode ficar nesse looping).
// Toda vez que startSession roda, cancelamos qualquer timer pendente da
// sessão — o que estamos fazendo agora já é a tentativa mais atual.
const reconnectTimers = new Map()

function clearReconnectTimer(id) {
  const timer = reconnectTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    reconnectTimers.delete(id)
  }
}

// Handle do watchdog de "connecting" travado, por sessão. Ver CONNECTING_TIMEOUT_MS acima.
const connectingWatchdogs = new Map()

function clearConnectingWatchdog(id) {
  const timer = connectingWatchdogs.get(id)
  if (timer) {
    clearTimeout(timer)
    connectingWatchdogs.delete(id)
  }
}

// Mesma ação de um POST /disconnect manual: encerra o socket e marca a sessão
// como "disconnected", sem agendar reconexão. Compartilhada entre a rota
// /disconnect e o watchdog de connecting travado, pra não duplicar a lógica.
async function forceDisconnect(id, entry) {
  entry.intentionalDisconnect = true
  clearReconnectTimer(id)
  clearConnectingWatchdog(id)
  entry.status = 'disconnected'
  await setSessionStatus(id, 'disconnected')
  entry.sock.end(undefined)
}

// Evita que duas chamadas concorrentes de /connect pro mesmo id criem dois
// sockets ao mesmo tempo brigando pela mesma credencial no Postgres.
// id -> Promise da chamada startSession() em andamento.
const startingSessions = new Map()

function startSessionSerialized(id) {
  const inFlight = startingSessions.get(id)
  if (inFlight) return inFlight

  const promise = startSession(id).finally(() => startingSessions.delete(id))
  startingSessions.set(id, promise)
  return promise
}

async function setSessionStatus(id, status, jid = undefined) {
  await pool.query(
    `UPDATE wa_sessions SET status = $2, jid = COALESCE($3, jid), updated_at = now() WHERE id = $1`,
    [id, status, jid ?? null]
  )
}

async function startSession(id) {
  // Qualquer reconexão agendada de uma queda anterior está obsoleta a partir
  // daqui — estamos iniciando a tentativa mais atual pra esta sessão.
  clearReconnectTimer(id)
  clearConnectingWatchdog(id)

  await pool.query(
    `INSERT INTO wa_sessions (id, status) VALUES ($1, 'connecting')
     ON CONFLICT (id) DO UPDATE SET status = 'connecting', updated_at = now()`,
    [id]
  )

  const { state, saveCreds } = await usePostgresAuthState(id)

  // Criado antes do socket pra poder ser referenciado pelo getMessage abaixo.
  const entry = {
    sock: null,
    status: 'connecting',
    qr: null,
    jid: null,
    intentionalDisconnect: false,
    // Cache em memória, limitado, das últimas mensagens enviadas por esta sessão.
    // É o que alimenta o getMessage do baileys (ver comentário abaixo).
    sentMessages: new Map()
  }
  sessions.set(id, entry)

  const sock = makeWASocket({
    // Só inclui a chave se já resolvemos uma versão — deixar `version: undefined`
    // explícito pisaria no default interno do baileys (o spread do makeWASocket
    // é {...defaults, ...config}, então uma chave presente com valor undefined
    // vence o default em vez de cair nele).
    ...(cachedBaileysVersion ? { version: cachedBaileysVersion } : {}),
    // Utilitários oficiais do baileys em vez de reimplementar: makeCacheableSignalKeyStore
    // adiciona uma camada de cache em memória sobre as chaves (reduz leitura no Postgres,
    // é o padrão recomendado pela própria lib) e Browsers.ubuntu gera o identificador de
    // dispositivo no formato que o WhatsApp espera — se a lib mudar esse formato no futuro,
    // isso é resolvido só atualizando o pacote, sem tocar no nosso código.
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    browser: Browsers.ubuntu('Bridge API'),
    // Essa bridge não lê chat/histórico — só dispara mensagem. O default do
    // baileys (syncFullHistory: true) baixa e decripta o histórico completo
    // de conversas a cada pareamento novo, o que custa tempo e banda à toa
    // pra um caso de uso que nunca vai consumir esse evento.
    syncFullHistory: false,
    // getMessage: a documentação do baileys trata isso como praticamente
    // obrigatório — é o que permite reenviar uma mensagem quando o WhatsApp
    // pede retry (evita mensagens travadas em "this message can take a
    // while" do lado de quem recebe). Guardamos só um cache limitado em
    // memória das últimas mensagens enviadas por sessão — não é um histórico
    // completo, só o suficiente pra atender um retry logo após o envio.
    // (O próprio baileys 7 já mantém um cache de retry interno — LRU de até
    // 512 mensagens por 5 minutos, ver enableRecentMessageCache, ligado por
    // padrão — e consulta ele antes de chamar nosso getMessage. Mantemos o
    // nosso mesmo assim como rede de segurança pra retries fora dessa janela.)
    getMessage: async (key) => entry.sentMessages.get(key.id)
    // (Nota: printQRInTerminal foi removido — está deprecated na doc atual;
    // já escutamos o campo `qr` no connection.update abaixo.)
  })
  entry.sock = sock

  if (CONNECTING_TIMEOUT_MS > 0) {
    connectingWatchdogs.set(
      id,
      setTimeout(async () => {
        // Confere identidade (não só o id): se uma sessão mais nova já
        // substituiu esta no meio do caminho, o watchdog desta é obsoleto.
        const current = sessions.get(id)
        if (current === entry && current.status === 'connecting') {
          console.log(
            `[${id}] "connecting" travado por mais de ${CONNECTING_TIMEOUT_MS}ms, ` +
              'forçando desconexão (sem reconectar sozinho — chame /connect manualmente)'
          )
          await forceDisconnect(id, entry)
        }
      }, CONNECTING_TIMEOUT_MS)
    )
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      entry.qr = qr
      entry.status = 'qr'
      clearConnectingWatchdog(id)
      await setSessionStatus(id, 'qr')
    }

    if (connection === 'open') {
      entry.status = 'connected'
      entry.qr = null
      entry.jid = sock.user?.id ?? null
      reconnectAttempts.set(id, 0)
      clearConnectingWatchdog(id)
      await setSessionStatus(id, 'connected', entry.jid)
      console.log(`[${id}] conectado como ${entry.jid}`)
    }

    if (connection === 'close') {
      clearConnectingWatchdog(id)
      if (entry.intentionalDisconnect) {
        entry.status = 'disconnected'
        await setSessionStatus(id, 'disconnected')
        clearReconnectTimer(id)
        console.log(`[${id}] desconectado (intencional, sem reconexão automática)`)
        return
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        entry.status = 'logged_out'
        console.log(`[${id}] sessão deslogada pelo WhatsApp, apagando credenciais`)
        await wipeAuthState(id)
        await setSessionStatus(id, 'logged_out')
        sessions.delete(id)
        reconnectAttempts.delete(id)
        clearReconnectTimer(id)
        return
      }

      // restartRequired (515) não é uma falha: o WhatsApp força esse
      // fechamento logo após o QR ser escaneado, como parte normal do
      // pareamento, e espera que a gente reconecte imediatamente — não
      // depois do delay configurado, e sem gastar tentativa do orçamento
      // de reconexão (ver "Connection Lifecycle" na doc do baileys).
      if (statusCode === DisconnectReason.restartRequired) {
        entry.status = 'reconnecting'
        await setSessionStatus(id, 'reconnecting')
        console.log(`[${id}] restartRequired (normal pós-QR), reconectando imediatamente...`)
        startSessionSerialized(id)
        return
      }

      const attempt = (reconnectAttempts.get(id) ?? 0) + 1
      reconnectAttempts.set(id, attempt)

      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        entry.status = 'error'
        await setSessionStatus(id, 'error')
        sessions.delete(id)
        clearReconnectTimer(id)
        console.log(`[${id}] desistindo após ${attempt - 1} tentativas — chame /connect manualmente pra tentar de novo`)
        return
      }

      entry.status = 'reconnecting'
      await setSessionStatus(id, 'reconnecting')
      console.log(
        `[${id}] conexão caiu, reconectando em ${RECONNECT_DELAY_MS}ms ` +
          `(tentativa ${attempt}/${RECONNECT_MAX_ATTEMPTS})...`
      )
      clearReconnectTimer(id)
      reconnectTimers.set(id, setTimeout(() => startSessionSerialized(id), RECONNECT_DELAY_MS))
    }
  })

  return entry
}

// Ao subir o processo, reconecta automaticamente toda sessão que não foi
// deslogada/removida NEM desconectada manualmente. 'disconnected' fica de
// fora de propósito: reconectar sozinho nesse caso quebraria a garantia
// documentada de que /disconnect nunca aciona reconexão automática — um
// restart do processo (deploy, crash, reagendamento pelo orquestrador) não
// deve ser um jeito indireto de driblar um /disconnect intencional.
async function restorePersistedSessions() {
  const { rows } = await pool.query(
    `SELECT id FROM wa_sessions WHERE status NOT IN ('logged_out', 'disconnected')`
  )
  for (const { id } of rows) {
    console.log(`Restaurando sessão persistida: ${id}`)
    await startSessionSerialized(id)
  }
}

// ---------------------- API ----------------------

const app = express()
app.use(express.json())

// Health check sem autenticação, útil pra load balancer / orquestrador.
app.get('/health', (req, res) => res.json({ ok: true }))

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  // Precisa ter o mesmo tamanho pra timingSafeEqual não lançar erro. Comparar
  // contra um buffer do mesmo tamanho de "b" primeiro evita que a checagem de
  // tamanho vaze quão perto a tentativa chegou do tamanho certo via early-return.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB) // mantém o tempo consistente mesmo no caso de tamanho diferente
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

// Todas as rotas de sessão exigem a API key global, enviada no header x-api-key.
app.use('/sessions', (req, res, next) => {
  const key = req.get('x-api-key')
  if (!key || !safeCompare(key, API_KEY)) {
    return res.status(401).json({ error: 'API key ausente ou inválida. Envie no header x-api-key.' })
  }
  next()
})

// Conecta (ou reconecta) uma sessão. O :id é o número, só dígitos com DDI.
app.post('/sessions/:id/connect', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  if (!NUMBER_FORMAT.test(id)) {
    return res.status(400).json({
      error: 'formato de número inválido. Use apenas dígitos com DDI, ex: 5511999999999'
    })
  }

  const existing = sessions.get(id)
  if (existing && ['connected', 'connecting', 'qr'].includes(existing.status)) {
    return res.json({ id, status: existing.status })
  }

  reconnectAttempts.set(id, 0)
  await startSessionSerialized(id)
  res.json({ id, status: 'connecting' })
})

// Fecha a conexão mas MANTÉM as credenciais salvas — dá pra reconectar depois sem novo QR.
// Também é o jeito de destravar manualmente uma sessão presa em "connecting"
// (ou em qualquer outro estado): sock.end() num socket já morto é um no-op
// seguro, então funciona mesmo se o socket já estiver travado/sem resposta.
app.post('/sessions/:id/disconnect', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const entry = sessions.get(id)
  if (!entry) return res.status(404).json({ error: 'sessão não está ativa neste processo' })

  await forceDisconnect(id, entry)
  res.json({ id, status: 'disconnecting' })
})

// Retorna o QR code (base64) para parear, ou o status atual da sessão
app.get('/sessions/:id/qr', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const entry = sessions.get(id)
  if (!entry) return res.status(404).json({ error: 'sessão não encontrada' })

  if (entry.status === 'connected') {
    return res.json({ status: 'connected', jid: entry.jid })
  }
  if (!entry.qr) {
    return res.json({ status: entry.status, qr: null })
  }
  const qrImage = await QRCode.toDataURL(entry.qr)
  res.json({ status: 'qr', qr: qrImage })
})

// Lista as sessões (persistidas no banco, não só as vivas neste processo)
app.get('/sessions', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, status, jid, updated_at FROM wa_sessions ORDER BY updated_at DESC'
  )
  res.json(rows)
})

// Logout definitivo: invalida a sessão no WhatsApp e apaga as credenciais salvas.
// Pra usar esse número de novo, precisa escanear o QR do zero.
app.delete('/sessions/:id', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const entry = sessions.get(id)

  if (entry) {
    entry.intentionalDisconnect = true
    try {
      await entry.sock.logout()
    } catch {
      // pode já estar desconectado, tudo bem
    }
    sessions.delete(id)
  }
  clearReconnectTimer(id)
  clearConnectingWatchdog(id)

  await wipeAuthState(id)
  await pool.query('DELETE FROM wa_sessions WHERE id = $1', [id])
  res.json({ id, status: 'removed' })
})

// Endpoint principal: dispara mensagem por uma sessão específica
app.post('/sessions/:id/messages', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const { to, message } = req.body

  if (!to || !message) {
    return res.status(400).json({ error: 'informe "to" e "message" no corpo' })
  }
  if (!NUMBER_FORMAT.test(normalizeNumber(to))) {
    return res.status(400).json({
      error: 'formato de "to" inválido. Use apenas dígitos com DDI, ex: 5511999999999'
    })
  }

  const entry = sessions.get(id)
  if (!entry) return res.status(404).json({ error: 'sessão não encontrada ou não ativa neste processo' })
  if (entry.status !== 'connected') {
    return res.status(409).json({ error: `sessão não está conectada (status: ${entry.status})` })
  }

  try {
    const jid = `${normalizeNumber(to)}@s.whatsapp.net`
    const result = await entry.sock.sendMessage(jid, { text: message })

    // Alimenta o cache que o getMessage usa pra atender pedidos de retry do
    // WhatsApp (ver comentário em startSession). Cache limitado — só serve
    // pra cobrir um retry logo após o envio, não é histórico permanente.
    if (result?.key?.id && result.message) {
      entry.sentMessages.set(result.key.id, result.message)
      if (entry.sentMessages.size > MAX_CACHED_MESSAGES_PER_SESSION) {
        const oldestKey = entry.sentMessages.keys().next().value
        entry.sentMessages.delete(oldestKey)
      }
    }

    res.json({ ok: true, id: result?.key?.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function main() {
  // migrate() TEM que terminar antes do listen(): senão uma requisição pode
  // chegar e consultar tabelas que ainda não existem.
  await migrate()
  // Bounded pelo timeout interno de resolveBaileysVersion — nunca trava o
  // boot indefinidamente mesmo se o GitHub estiver inacessível.
  await resolveBaileysVersion()
  app.listen(PORT, () => {
    console.log(`Bridge API rodando em http://localhost:${PORT}`)
  })
  await restorePersistedSessions()
}

main().catch((err) => {
  console.error('Falha ao iniciar a bridge:', err)
  process.exit(1)
})

process.on('SIGTERM', async () => {
  await pool.end()
  process.exit(0)
})

// Rede de segurança: o baileys mexe com WebSocket cru e criptografia de sinal,
// e ocasionalmente solta uma rejeição/erro que não passa pelos handlers acima.
// Preferimos logar e manter o processo (e as outras sessões) de pé a derrubar
// a bridge inteira por causa de uma sessão problemática.
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (bridge segue rodando):', err)
})
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (bridge segue rodando):', err)
})
