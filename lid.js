import {
  areJidsSameUser,
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser
} from 'baileys'

// Tratamento de LID (Linked ID) nas mensagens recebidas.
//
// O WhatsApp está migrando contatos de "número@s.whatsapp.net" (PN) pra um
// identificador opaco "<id>@lid", que não revela o telefone. No Baileys 7 a
// key de cada mensagem traz o endereço principal (remoteJid/participant) e,
// quando o servidor informa, o "outro lado" do par em remoteJidAlt (conversa
// individual) ou participantAlt (grupo), mais addressingMode 'lid' | 'pn'
// (ver decodeMessageNode/extractAddressingContext em
// Utils/decode-wa-message.js do pacote).
//
// Quem consome os webhooks (texteaseai → Chatwoot) identifica o contato pelo
// telefone, então seguimos a regra da Evolution 2.4: se o endereço principal
// for LID e o PN for conhecido, o PN vira o remoteJid e o LID vai pro
// remoteJidAlt, com addressingMode 'pn'. Duas diferenças em relação à Evolution:
//
// 1. Em mensagem fromMe (mandada pelo próprio número em outro aparelho), o
//    remoteJidAlt do Baileys pode ser o alt do REMETENTE — ou seja, o nosso
//    próprio número —, porque extractAddressingContext calcula o alt a partir
//    de participant||from (que é o nosso aparelho). A Evolution troca sem
//    checar e acaba gravando a conversa com o nosso próprio número. Aqui um alt
//    que seja o próprio usuário é descartado.
// 2. Quando o alt não vem na stanza, consultamos o mapeamento LID→PN que o
//    próprio Baileys mantém (signalRepository.lidMapping, persistido nas chaves
//    "lid-mapping-*" do wa_auth_state) antes de desistir.
//
// Se nada resolver, a mensagem segue com o LID mesmo (addressingMode 'lid'):
// contatos com número oculto existem e o consumidor precisa aceitar isso.

export function isLidJid(jid) {
  return Boolean(isLidUser(jid) || isHostedLidUser(jid))
}

function isPnJid(jid) {
  return Boolean(isPnUser(jid) || isHostedPnUser(jid))
}

// Remove o sufixo de dispositivo (":12") e unifica @c.us → @s.whatsapp.net.
function normalizeUser(jid) {
  return jid ? jidNormalizedUser(jid) : undefined
}

// Resolver LID→PN em cima do socket. Nunca lança: falha de lookup não pode
// derrubar o processamento da mensagem, só deixa ela com o LID.
export function makePnResolver(sock) {
  return async (lid) => {
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(lid)
      return pn ? jidNormalizedUser(pn) : null
    } catch {
      return null
    }
  }
}

async function safeResolve(resolvePn, lid) {
  if (!resolvePn) return null
  try {
    const pn = await resolvePn(lid)
    return pn && isPnJid(pn) ? normalizeUser(pn) : null
  } catch {
    return null
  }
}

// Escolhe o PN de um endereço LID: primeiro o alt informado na stanza, depois
// o mapeamento local. Retorna null se não souber.
async function pnFor(lid, alt, resolvePn) {
  if (alt && isPnJid(alt)) return alt
  return safeResolve(resolvePn, lid)
}

/**
 * Normaliza o endereçamento de uma WAMessageKey no formato que a Evolution
 * entrega nos webhooks. Não altera o objeto recebido.
 *
 * @param key       key da mensagem (messages.upsert / messages.update)
 * @param options.resolvePn  async (lid) => pn | null (ver makePnResolver)
 * @param options.ownJids    jids do próprio número (sock.user.id, sock.user.lid),
 *                           pra descartar alt que aponta pra nós mesmos
 */
export async function normalizeKeyAddressing(key, { resolvePn, ownJids = [] } = {}) {
  const out = { ...key }
  const isOwn = (jid) => ownJids.some((own) => own && areJidsSameUser(jid, own))

  out.remoteJid = normalizeUser(key.remoteJid)

  if (isJidGroup(out.remoteJid)) {
    // Em grupo o alt calculado pelo Baileys é do participant (autor), mesmo
    // quando o autor somos nós — então aqui não há o problema do fromMe.
    const participant = normalizeUser(key.participant)
    const participantAlt = normalizeUser(key.participantAlt)

    if (participant && isLidJid(participant)) {
      const pn = await pnFor(participant, participantAlt, resolvePn)
      if (pn) {
        out.participant = pn
        out.participantAlt = participant
        out.addressingMode = 'pn'
      } else {
        out.participant = participant
        delete out.participantAlt
        out.addressingMode = 'lid'
      }
    } else {
      if (participant) out.participant = participant
      if (participantAlt && isLidJid(participantAlt)) out.participantAlt = participantAlt
      else delete out.participantAlt
      out.addressingMode = 'pn'
    }
    return out
  }

  // Broadcast, newsletter etc. não são endereços de usuário — ficam como vieram
  // (o filtro de recebimento descarta esses casos antes de chegar no webhook).
  if (!isLidJid(out.remoteJid) && !isPnJid(out.remoteJid)) return out

  let alt = normalizeUser(key.remoteJidAlt)
  if (alt && key.fromMe && isOwn(alt)) alt = undefined

  if (isLidJid(out.remoteJid)) {
    const lid = out.remoteJid
    const pn = await pnFor(lid, alt, resolvePn)
    if (pn) {
      out.remoteJid = pn
      out.remoteJidAlt = lid
      out.addressingMode = 'pn'
    } else {
      delete out.remoteJidAlt
      out.addressingMode = 'lid'
    }
  } else {
    if (alt && isLidJid(alt)) out.remoteJidAlt = alt
    else delete out.remoteJidAlt
    out.addressingMode = 'pn'
  }

  return out
}
