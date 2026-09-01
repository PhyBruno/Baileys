import 'dotenv/config'
import crypto from 'crypto'
import express from 'express'
import QRCode from 'qrcode'
import pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  WAMessageStatus
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

// Limite de tamanho do body JSON aceito pela API. O default do express
// (100kb) é insuficiente pra imagem/documento em base64 (que já infla ~33%
// o tamanho do binário original) — sem aumentar isso, todo envio de mídia
// real seria rejeitado com 413 antes de chegar na validação da rota.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '20mb'

// sock.sendMessage() resolve assim que a mensagem é repassada pro servidor do
// WhatsApp (relay) — não quando o destinatário recebe de verdade. O status
// real (aceito pelo servidor, entregue no aparelho, ou erro) chega depois,
// de forma assíncrona, via evento 'messages.update'. Pra devolver isso na
// mesma resposta HTTP do POST /messages, esperamos até esse tempo por uma
// atualização de status antes de responder. 0 desativa a espera (responde
// assim que sendMessage() resolver, sem aguardar confirmação).
const MESSAGE_STATUS_TIMEOUT_MS = Number(process.env.MESSAGE_STATUS_TIMEOUT_MS ?? 8_000)

if (!Number.isFinite(MESSAGE_STATUS_TIMEOUT_MS) || MESSAGE_STATUS_TIMEOUT_MS < 0) {
  console.error('ERRO: MESSAGE_STATUS_TIMEOUT_MS precisa ser um número >= 0 (0 desativa a espera).')
  process.exit(1)
}

// Nomes legíveis pro enum numérico do baileys (ERROR=0, PENDING=1,
// SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5), pra devolver na API em vez
// do número cru.
const MESSAGE_STATUS_NAMES = Object.fromEntries(
  Object.entries(WAMessageStatus).map(([name, value]) => [value, name.toLowerCase()])
)

// Espera por uma atualização de status (via 'messages.update') pra uma
// mensagem específica, até timeoutMs. Resolve assim que chegar ERROR (falha
// confirmada) ou qualquer status >= SERVER_ACK (servidor confirmou o
// recebimento — não esperamos até DELIVERY_ACK/READ porque isso pode nunca
// chegar se o destinatário ficar offline, e não é isso que essa API promete).
// Se estourar o timeout sem nenhuma atualização, resolve com null — isso NÃO
// significa falha, só que não deu tempo de confirmar (a mensagem já foi
// aceita pelo relay antes desta função ser chamada).
function waitForMessageStatus(sock, messageId, timeoutMs) {
  if (timeoutMs <= 0) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.ev.off('messages.update', onUpdate)
      resolve(status)
    }

    const onUpdate = (updates) => {
      for (const { key, update } of updates) {
        if (key.id !== messageId || typeof update.status !== 'number') continue
        if (update.status === WAMessageStatus.ERROR || update.status >= WAMessageStatus.SERVER_ACK) {
          finish(update.status)
          return
        }
      }
    }

    const timer = setTimeout(() => finish(null), timeoutMs)
    sock.ev.on('messages.update', onUpdate)
  })
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

// Decodifica uma string base64 (aceita o prefixo opcional de data URL, ex:
// "data:image/png;base64,...") pro Buffer que o baileys espera em
// image/document. Retorna null se a string não for base64 válido ou vier
// vazia — o chamador decide como responder (400), em vez desta função
// lançar exceção pra um caso de erro totalmente esperado (input do cliente).
function decodeBase64Media(raw) {
  if (typeof raw !== 'string') return null
  const commaIdx = raw.indexOf(',')
  const cleaned = (raw.startsWith('data:') && commaIdx !== -1 ? raw.slice(commaIdx + 1) : raw).replace(/\s+/g, '')
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null
  return Buffer.from(cleaned, 'base64')
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
app.use(express.json({ limit: JSON_BODY_LIMIT }))

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

  // 'reconnecting' entra na mesma lista dos outros estados "ativos": a sessão
  // já tem um socket em andamento (esperando o backoff de RECONNECT_DELAY_MS
  // pra tentar de novo sozinha), então um /connect manual aqui não deve
  // atropelar esse timer. Sem isso, um consumidor da API chamando /connect
  // repetidamente sem checar o status martelava o WhatsApp com tentativas
  // mais rápido do que o backoff configurado pretende.
  const existing = sessions.get(id)
  if (existing && ['connected', 'connecting', 'qr', 'reconnecting'].includes(existing.status)) {
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

// Endpoint principal: dispara mensagem (texto, imagem ou documento) por uma
// sessão específica. "type" default é "text", pra manter compatibilidade
// total com o formato antigo { to, message }. Imagem/documento vão em
// "mediaBase64" — de propósito NÃO existe um "mediaUrl" que o servidor
// buscaria sozinho: isso seria SSRF (fetch de URL arbitrária vinda de
// qualquer cliente que tenha a API key global), então mídia só entra
// embutida no próprio request.
app.post('/sessions/:id/messages', async (req, res) => {
  const id = normalizeNumber(req.params.id)
  const { to, message, type = 'text', mediaBase64, mimetype, fileName, caption } = req.body

  if (!to) {
    return res.status(400).json({ error: 'informe "to" no corpo' })
  }
  if (!NUMBER_FORMAT.test(normalizeNumber(to))) {
    return res.status(400).json({
      error: 'formato de "to" inválido. Use apenas dígitos com DDI, ex: 5511999999999'
    })
  }
  if (!['text', 'image', 'document'].includes(type)) {
    return res.status(400).json({ error: 'campo "type" inválido. Use "text" (default), "image" ou "document".' })
  }

  let content
  if (type === 'text') {
    if (!message) {
      return res.status(400).json({ error: 'informe "message" no corpo (obrigatório quando "type" é "text")' })
    }
    content = { text: message }
  } else {
    if (!mediaBase64) {
      return res.status(400).json({ error: `informe "mediaBase64" no corpo (obrigatório quando "type" é "${type}")` })
    }
    const buffer = decodeBase64Media(mediaBase64)
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: '"mediaBase64" inválido ou vazio (aceita base64 puro ou data URL "data:<mime>;base64,...")' })
    }

    if (type === 'document') {
      // mimetype é obrigatório pro baileys aqui (diferente de "image", que
      // detecta sozinho se omitido) — ver AnyMediaMessageContent no pacote.
      if (!mimetype) {
        return res.status(400).json({ error: 'informe "mimetype" no corpo (obrigatório quando "type" é "document")' })
      }
      content = { document: buffer, mimetype, fileName: fileName || 'arquivo', caption: caption || undefined }
    } else {
      content = { image: buffer, caption: caption || undefined, ...(mimetype ? { mimetype } : {}) }
    }
  }

  const entry = sessions.get(id)
  if (!entry) return res.status(404).json({ error: 'sessão não encontrada ou não ativa neste processo' })
  if (entry.status !== 'connected') {
    return res.status(409).json({ error: `sessão não está conectada (status: ${entry.status})` })
  }

  try {
    // Não confiamos no formato de dígitos que o cliente mandou pra montar o
    // JID na mão. Números brasileiros têm o "9" adicional ambíguo (uma conta
    // pode estar registrada com ou sem ele, dependendo de quando/como foi
    // cadastrada) — montar "${numero}@s.whatsapp.net" direto manda pra um JID
    // que pode não existir de verdade. O Baileys não valida isso no envio: ele
    // aceita, criptografa e devolve um id de mensagem (result.key.id) mesmo
    // pra um JID fantasma, então "ok: true" sozinho NÃO prova entrega.
    // onWhatsApp() pergunta pro próprio servidor do WhatsApp qual é o JID
    // canônico daquele número (é quem realmente sabe resolver o 9), então
    // usamos o JID que ele devolve em vez do que construímos aqui.
    const [resolved] = (await entry.sock.onWhatsApp(normalizeNumber(to))) || []
    if (!resolved?.exists) {
      return res.status(404).json({ error: `número "${to}" não está registrado no WhatsApp (ou não foi possível confirmar)` })
    }

    const result = await entry.sock.sendMessage(resolved.jid, content)

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

    // sendMessage() já retornou (a mensagem foi repassada ao servidor do
    // WhatsApp), mas isso não confirma entrega. Esperamos até
    // MESSAGE_STATUS_TIMEOUT_MS por uma atualização de status real antes de
    // responder — ver comentário de waitForMessageStatus.
    const statusCode = result?.key?.id
      ? await waitForMessageStatus(entry.sock, result.key.id, MESSAGE_STATUS_TIMEOUT_MS)
      : null

    if (statusCode === WAMessageStatus.ERROR) {
      return res.status(502).json({
        ok: false,
        id: result?.key?.id,
        status: 'error',
        error: 'o WhatsApp recusou/falhou ao entregar esta mensagem (confirmado via messages.update)'
      })
    }

    res.json({
      ok: true,
      id: result?.key?.id,
      // 'unknown' quando o timeout estourou sem confirmação — não é falha,
      // só significa que a entrega ainda não foi confirmada nesse tempo.
      status: statusCode === null ? 'unknown' : MESSAGE_STATUS_NAMES[statusCode]
    })
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
