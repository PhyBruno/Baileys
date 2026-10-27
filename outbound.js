// Envio pela rota POST /sessions/:id/messages: validação do corpo, montagem do
// conteúdo do Baileys e o fluxo de envio. Fica fora do server.js pra poder ser
// testado com um socket falso (o server.js sobe banco e sessões ao ser
// importado). As dependências que mexem no estado do processo (sessões,
// cache de retry, gravação em wa_messages, espera de status) chegam por
// createSendMessageHandler.

import { jidNormalizedUser } from 'baileys'

// Formato aceito para o ID da sessão e para o destinatário de mensagens:
// apenas dígitos, com DDI incluído (ex: 5511999999999). Nada de "+", espaço ou "-".
export const NUMBER_FORMAT = /^\d{8,15}$/

// JID de grupo aceito em "to" (só na rota /messages): os dois formatos do
// WhatsApp, o atual (120363...@g.us) e o antigo (<criador>-<timestamp>@g.us).
export const GROUP_JID_FORMAT = /^[0-9]+(-[0-9]+)?@g\.us$/

// JID de usuário em LID aceito em "to" (só na rota /messages), com ou sem
// sufixo de dispositivo ":N" (ex: 123456789012345@lid ou 123456789012345:3@lid).
export const LID_JID_FORMAT = /^[0-9]+(:[0-9]+)?@lid$/

export const MESSAGE_TYPES = ['text', 'image', 'video', 'document', 'audio']

export function normalizeNumber(raw) {
  return String(raw).replace(/\D/g, '')
}

// Campo "number" dos endpoints compatíveis com a Evolution: aceita só dígitos
// com DDI (5511999999999) ou o JID de usuário (5511999999999@s.whatsapp.net,
// com ou sem sufixo de dispositivo ":N"). Grupo (@g.us), @lid, broadcast etc.
// ficam de fora de propósito — o fluxo de envio desta bridge é só conversa
// individual. Sem essa checagem, normalizeNumber() transformaria um JID de
// grupo em "dígitos" e ele passaria como se fosse um número. Retorna os
// dígitos ou null.
export function parseRecipientNumber(raw) {
  if (typeof raw !== 'string') return null
  let user = raw.trim()
  if (user.includes('@')) {
    if (!user.endsWith('@s.whatsapp.net')) return null
    user = user.slice(0, user.indexOf('@')).replace(/:\d+$/, '')
  }
  const digits = normalizeNumber(user)
  return NUMBER_FORMAT.test(digits) ? digits : null
}

// Decodifica uma string base64 (aceita o prefixo opcional de data URL, ex:
// "data:image/png;base64,...") pro Buffer que o baileys espera em
// image/video/document. Retorna null se a string não for base64 válido ou vier
// vazia — o chamador decide como responder (400), em vez desta função
// lançar exceção pra um caso de erro totalmente esperado (input do cliente).
export function decodeBase64Media(raw) {
  if (typeof raw !== 'string') return null
  const commaIdx = raw.indexOf(',')
  const cleaned = (raw.startsWith('data:') && commaIdx !== -1 ? raw.slice(commaIdx + 1) : raw).replace(/\s+/g, '')
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null
  return Buffer.from(cleaned, 'base64')
}

// Destino do campo "to": { number } (dígitos com DDI ou JID @s.whatsapp.net),
// { lid } (JID @lid, sem o sufixo de dispositivo), { group } (JID de grupo) ou
// null. Os demais JIDs (@newsletter, @broadcast etc.) são recusados: antes,
// normalizeNumber() tirava o sufixo e o JID passava como se fosse um número.
export function parseSendTarget(to) {
  if (typeof to !== 'string' && typeof to !== 'number') return null
  const raw = String(to).trim()
  if (GROUP_JID_FORMAT.test(raw)) return { group: raw }
  if (LID_JID_FORMAT.test(raw)) return { lid: jidNormalizedUser(raw) }
  if (raw.includes('@')) {
    const number = parseRecipientNumber(raw)
    return number ? { number } : null
  }
  const digits = normalizeNumber(raw)
  return NUMBER_FORMAT.test(digits) ? { number: digits } : null
}

// O número da sessão participa do grupo? Compara o PN e o LID da sessão (sem
// sufixo de dispositivo) com o id de cada participante e com os campos alt
// que o Baileys 7 traz (lid/phoneNumber): em grupo com addressingMode 'lid'
// o id do participante é o LID.
export function isGroupParticipant(metadata, user) {
  if (!Array.isArray(metadata?.participants)) return false
  const own = new Set([user?.id, user?.lid].filter(Boolean).map(normalizedJid).filter(Boolean))
  if (own.size === 0) return false
  return metadata.participants.some((participant) =>
    [participant?.id, participant?.lid, participant?.phoneNumber].some((jid) => own.has(normalizedJid(jid)))
  )
}

function normalizedJid(jid) {
  if (typeof jid !== 'string' || jid.length === 0) return null
  return jidNormalizedUser(jid) || null
}

// Conteúdo do sock.sendMessage a partir do corpo: { content } ou { error } (400).
export function buildMessageContent({ type = 'text', message, mediaBase64, mimetype, fileName, caption, ptt } = {}) {
  if (!MESSAGE_TYPES.includes(type)) {
    return { error: 'campo "type" inválido. Use "text" (default), "image", "video", "document" ou "audio".' }
  }

  if (type === 'text') {
    if (!message) {
      return { error: 'informe "message" no corpo (obrigatório quando "type" é "text")' }
    }
    return { content: { text: message } }
  }

  if (!mediaBase64) {
    return { error: `informe "mediaBase64" no corpo (obrigatório quando "type" é "${type}")` }
  }
  const buffer = decodeBase64Media(mediaBase64)
  if (!buffer || buffer.length === 0) {
    return { error: '"mediaBase64" inválido ou vazio (aceita base64 puro ou data URL "data:<mime>;base64,...")' }
  }

  if (type === 'document') {
    // mimetype é obrigatório pro baileys aqui (diferente de "image", que
    // detecta sozinho se omitido) — ver AnyMediaMessageContent no pacote.
    if (!mimetype) {
      return { error: 'informe "mimetype" no corpo (obrigatório quando "type" é "document")' }
    }
    return { content: { document: buffer, mimetype, fileName: fileName || 'arquivo', caption: caption || undefined } }
  }
  if (type === 'video') {
    // Também obrigatório aqui: sem mimetype o WhatsApp não sabe tocar o
    // vídeo no aparelho (o baileys não detecta sozinho como na imagem).
    if (!mimetype) {
      return { error: 'informe "mimetype" no corpo (obrigatório quando "type" é "video")' }
    }
    return { content: { video: buffer, mimetype, caption: caption || undefined } }
  }
  if (type === 'audio') {
    // Obrigatório como no vídeo. Voz (ptt) do WhatsApp: "audio/ogg; codecs=opus".
    if (!mimetype) {
      return { error: 'informe "mimetype" (obrigatório quando "type" é "audio")' }
    }
    // ptt: true = mensagem de voz (balão de voz); qualquer outro valor = arquivo de áudio.
    return { content: { audio: buffer, mimetype, ptt: ptt === true } }
  }
  return { content: { image: buffer, caption: caption || undefined, ...(mimetype ? { mimetype } : {}) } }
}

/**
 * Handler de POST /sessions/:id/messages.
 *
 * getConnectedEntry(id, res)          → entry conectada ou null (já respondeu 404/409)
 * generateMessageId(userJid)          → id da mensagem, gerado antes do envio
 * waitForStatus(sock, messageId)      → promessa do status (ver waitForMessageStatus)
 * cacheSentMessage(entry, id, msg)    → cache do getMessage (retry do WhatsApp)
 * recordApiMessage(id, entry, full)   → grava em wa_messages (origin = 'api'), sem await
 * respondWithMessageStatus(res, id, statusPromise)
 * cachedGroupMetadata(id, groupJid)   → metadata do grupo em memória, ainda válido, ou
 *                                       undefined (aí consulta sock.groupMetadata). Opcional.
 */
export function createSendMessageHandler({
  getConnectedEntry,
  generateMessageId,
  waitForStatus,
  cacheSentMessage,
  recordApiMessage,
  respondWithMessageStatus,
  cachedGroupMetadata = async () => undefined,
  log = console
}) {
  // Falha da consulta (grupo inexistente, número removido, sem permissão) vira
  // null: a rota responde 404, como "número não registrado" no individual.
  async function loadGroupMetadata(id, sock, jid) {
    try {
      return (await cachedGroupMetadata(id, jid)) ?? (await sock.groupMetadata(jid))
    } catch {
      return null
    }
  }


  return async (req, res) => {
    const id = normalizeNumber(req.params.id)
    const body = req.body ?? {}

    if (!body.to) {
      return res.status(400).json({ error: 'informe "to" no corpo' })
    }
    const target = parseSendTarget(body.to)
    if (!target) {
      return res.status(400).json({
        error: String(body.to).includes('@')
          ? 'formato de "to" inválido. Use dígitos com DDI (ex: 5511999999999), o JID de usuário ' +
            '(ex: 5511999999999@s.whatsapp.net ou 123456789012345@lid) ou o JID de um grupo ' +
            '(ex: 120363000000000001@g.us). @newsletter e @broadcast não são aceitos.'
          : 'formato de "to" inválido. Use apenas dígitos com DDI, ex: 5511999999999'
      })
    }
    const built = buildMessageContent(body)
    if (built.error) return res.status(400).json({ error: built.error })

    const entry = getConnectedEntry(id, res)
    if (!entry) return

    try {
      let jid
      if (target.group) {
        // Grupo: onWhatsApp() não existe pra JID de grupo, e o JID já é o
        // canônico. Antes de enviar, confere que o número da sessão participa
        // — sem isso o Baileys tentaria enviar a um grupo de que saiu.
        const metadata = await loadGroupMetadata(id, entry.sock, target.group)
        if (!isGroupParticipant(metadata, entry.sock.user)) {
          return res.status(404).json({ error: 'grupo não encontrado ou o número não participa' })
        }
        jid = target.group
      } else if (target.lid) {
        // LID: o onWhatsApp() não aceita LID (o Baileys ignora com um aviso),
        // e o LID é opaco e já canônico, sem a ambiguidade do 9. Vai direto.
        jid = target.lid
      } else {
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
        const [resolved] = (await entry.sock.onWhatsApp(target.number)) || []
        if (!resolved?.exists) {
          return res.status(404).json({ error: `número "${body.to}" não está registrado no WhatsApp (ou não foi possível confirmar)` })
        }
        jid = resolved.jid
      }

      // Id gerado e registrado ANTES do envio: o sendMessage emite o eco
      // (messages.upsert 'append') num nextTick antes de retornar, e o
      // listener precisa reconhecer esse eco como 'api' (research R4). O
      // ...options do Baileys sobrescreve o id que ele geraria sozinho.
      const messageId = generateMessageId(entry.sock.user.id)
      entry.apiMessageIds.mark(messageId)

      const result = await entry.sock.sendMessage(jid, built.content, { messageId })
      const statusPromise = waitForStatus(entry.sock, result?.key?.id)
      cacheSentMessage(entry, result?.key?.id, result?.message)
      recordApiMessage(id, entry, result).catch((err) =>
        log.error(`[${id}] falha ao gravar mensagem enviada ${result?.key?.id}: ${err.message}`)
      )
      await respondWithMessageStatus(res, result?.key?.id, statusPromise)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }
}
