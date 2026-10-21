import crypto from 'crypto'
import { proto } from 'baileys'

// Listas e botões interativos, com o MESMO payload dos endpoints
// /message/sendList e /message/sendButtons da Evolution API 2.4.0.
//
// Referência: commit 35a4bd44 da Evolution (branch develop, versão 2.4.0) —
// helpers/interactiveMessage.helper.ts e as funções listMessage() /
// buttonMessage() de whatsapp.baileys.service.ts. Antes desse commit (todo o
// 2.3.x) a Evolution montava o proto certo mas não mandava o nó <biz>, e o
// WhatsApp aceitava o envio (devolvia id) e descartava a mensagem em silêncio.
//
// O sock.sendMessage() do baileys não aceita listMessage/interactiveMessage
// nem sabe adicionar o nó <biz> na stanza (só adiciona nós de poll/event, ver
// Socket/messages-send.js). Por isso estas mensagens são montadas aqui e
// enviadas pelo server.js via sock.relayMessage(..., { additionalNodes }).

// Nó <biz> exigido pra lista renderizar (sem ele o WhatsApp descarta a mensagem).
export const LIST_BIZ_NODE = {
  tag: 'biz',
  attrs: {},
  content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }]
}

// Nó <biz> exigido pros botões (native flow) renderizarem.
export const BUTTONS_BIZ_NODE = {
  tag: 'biz',
  attrs: {},
  content: [
    {
      tag: 'interactive',
      attrs: { type: 'native_flow', v: '1' },
      content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
    }
  ]
}

// type do payload -> nome do botão no nativeFlowMessage (mapType da Evolution).
const NATIVE_FLOW_NAMES = {
  reply: 'quick_reply',
  copy: 'cta_copy',
  url: 'cta_url',
  call: 'cta_call',
  pix: 'payment_info'
}

// keyType do payload -> key_type da chave PIX (mapKeyType da Evolution).
const PIX_KEY_TYPES = {
  phone: 'PHONE',
  email: 'EMAIL',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  random: 'EVP'
}

const CTA_TYPES = ['url', 'call', 'copy']

// Campo obrigatório de cada tipo de botão de CTA, além do displayText. A
// Evolution não valida isso (manda o botão com o campo undefined, que chega
// quebrado no aparelho) — aqui viramos 400 antes de enviar.
const CTA_REQUIRED_FIELD = { url: 'url', call: 'phoneNumber', copy: 'copyCode' }

const isString = (value) => typeof value === 'string'
const isNonEmptyString = (value) => isString(value) && value.length > 0
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Equivalente ao "uniqueItems: true" do JSON Schema da Evolution.
const hasDuplicates = (items) => new Set(items.map((item) => JSON.stringify(item))).size !== items.length

// Mesmo formato do generateRandomId() da Evolution (11 caracteres A-Z0-9).
function generateRandomId(length = 11) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < length; i++) result += characters[crypto.randomInt(characters.length)]
  return result
}

// Valida campos de texto opcionais: se vierem, têm que ser string.
function checkOptionalStrings(obj, fields, prefix = '') {
  for (const field of fields) {
    if (obj[field] !== undefined && !isString(obj[field])) return `"${prefix}${field}" precisa ser texto`
  }
  return null
}

// Valida o payload de /sendList (regras do listMessageSchema da Evolution) e
// monta o proto. Retorna { error } ou { message }.
export function buildListMessage(body) {
  for (const field of ['title', 'footerText', 'buttonText']) {
    if (!isString(body[field])) return { error: `informe "${field}" no corpo (texto)` }
  }
  const optionalError = checkOptionalStrings(body, ['description'])
  if (optionalError) return { error: optionalError }

  const { sections } = body
  if (!Array.isArray(sections) || sections.length === 0) {
    return { error: 'informe "sections" no corpo (lista com ao menos uma seção)' }
  }
  if (hasDuplicates(sections)) return { error: '"sections" não pode ter seções repetidas' }

  for (const [s, section] of sections.entries()) {
    const at = `sections[${s}]`
    if (!isPlainObject(section)) return { error: `"${at}" precisa ser um objeto` }
    if (!isNonEmptyString(section.title)) return { error: `informe "${at}.title" (texto não vazio)` }
    if (!Array.isArray(section.rows) || section.rows.length === 0) {
      return { error: `informe "${at}.rows" (lista com ao menos uma linha)` }
    }
    if (hasDuplicates(section.rows)) return { error: `"${at}.rows" não pode ter linhas repetidas` }

    for (const [r, row] of section.rows.entries()) {
      const rowAt = `${at}.rows[${r}]`
      if (!isPlainObject(row)) return { error: `"${rowAt}" precisa ser um objeto` }
      if (!isNonEmptyString(row.title)) return { error: `informe "${rowAt}.title" (texto não vazio)` }
      if (!isNonEmptyString(row.rowId)) return { error: `informe "${rowAt}.rowId" (texto não vazio)` }
      if (row.description !== undefined && !isNonEmptyString(row.description)) {
        return { error: `"${rowAt}.description" precisa ser texto não vazio (ou ser omitido)` }
      }
    }
  }

  // Formato LEGADO (listMessage com SINGLE_SELECT), como a Evolution 2.4.0: o
  // formato moderno (interactiveMessage + single_select) chega vazio no
  // WhatsApp Web/Desktop. "footerText" é o rodapé da lista.
  return {
    message: {
      listMessage: {
        title: body.title,
        description: body.description || '',
        buttonText: body.buttonText || 'Ver Menu',
        footerText: body.footerText,
        listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
        sections: sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            title: row.title,
            description: row.description || '',
            rowId: row.rowId
          }))
        }))
      }
    }
  }
}

function toButtonParamsJson(button) {
  switch (button.type) {
    case 'reply':
      // A Evolution aceita reply sem id; geramos um pra o botão não ir sem identificador.
      return JSON.stringify({ display_text: button.displayText, id: button.id ?? generateRandomId() })
    case 'copy':
      return JSON.stringify({ display_text: button.displayText, copy_code: button.copyCode })
    case 'url':
      return JSON.stringify({ display_text: button.displayText, url: button.url, merchant_url: button.url })
    case 'call':
      return JSON.stringify({ display_text: button.displayText, phone_number: button.phoneNumber })
    case 'pix':
      return JSON.stringify({
        currency: button.currency,
        total_amount: { value: 0, offset: 100 },
        reference_id: generateRandomId(),
        type: 'physical-goods',
        order: {
          status: 'pending',
          subtotal: { value: 0, offset: 100 },
          order_type: 'ORDER',
          items: [{ name: '', amount: { value: 0, offset: 100 }, quantity: 0, sale_amount: { value: 0, offset: 100 } }]
        },
        payment_settings: [
          {
            type: 'pix_static_code',
            pix_static_code: {
              merchant_name: button.name,
              key: button.key,
              key_type: PIX_KEY_TYPES[button.keyType]
            }
          }
        ],
        share_payment_status: false
      })
  }
}

// Valida o payload de /sendButtons (buttonsMessageSchema + regras de
// buttonMessage() da Evolution). Não monta o proto ainda porque a imagem do
// cabeçalho (thumbnailUrl) precisa ser enviada antes pro servidor de mídia do
// WhatsApp — ver buildButtonsMessage. Retorna a mensagem de erro ou null.
//
// Além do payload da Evolution, aceita "headerText" (cabeçalho em texto, que
// a Evolution não tem) e deixa todas as partes opcionais: cabeçalho (texto
// OU imagem), corpo (title/description), rodapé e botões — testado num
// aparelho real, todas as combinações renderizam, inclusive sem botões e sem
// corpo.
export function validateButtonsPayload(body) {
  const optionalError = checkOptionalStrings(body, ['title', 'description', 'footer', 'thumbnailUrl', 'headerText'])
  if (optionalError) return optionalError

  // O cabeçalho de uma mensagem interativa é de um tipo só.
  if (body.headerText && body.thumbnailUrl) {
    return 'use "headerText" (cabeçalho em texto) OU "thumbnailUrl" (cabeçalho com imagem), não os dois'
  }

  const buttons = body.buttons ?? []
  if (!Array.isArray(buttons)) return '"buttons" precisa ser uma lista'

  if (buttons.length === 0) {
    if (!body.headerText && !body.thumbnailUrl && !body.title && !body.description) {
      return 'a mensagem precisa ter ao menos cabeçalho ("headerText" ou "thumbnailUrl"), corpo ("title"/"description") ou "buttons"'
    }
    return null
  }

  for (const [i, button] of buttons.entries()) {
    const at = `buttons[${i}]`
    if (!isPlainObject(button)) return `"${at}" precisa ser um objeto`
    if (!NATIVE_FLOW_NAMES[button.type]) {
      return `"${at}.type" inválido. Use "reply", "copy", "url", "call" ou "pix".`
    }
    const fieldError = checkOptionalStrings(
      button,
      ['displayText', 'id', 'url', 'copyCode', 'phoneNumber', 'currency', 'name', 'key'],
      `${at}.`
    )
    if (fieldError) return fieldError
    for (const field of ['id', 'url', 'phoneNumber']) {
      if (button[field] !== undefined && !isNonEmptyString(button[field])) {
        return `"${at}.${field}" não pode ser vazio`
      }
    }
    if (button.keyType !== undefined && !PIX_KEY_TYPES[button.keyType]) {
      return `"${at}.keyType" inválido. Use "phone", "email", "cpf", "cnpj" ou "random".`
    }

    if (button.type === 'pix') {
      for (const field of ['name', 'key', 'keyType']) {
        if (!isNonEmptyString(button[field])) return `informe "${at}.${field}" (obrigatório no botão "pix")`
      }
    } else {
      if (!isNonEmptyString(button.displayText)) {
        return `informe "${at}.displayText" (obrigatório no botão "${button.type}")`
      }
      const required = CTA_REQUIRED_FIELD[button.type]
      if (required && !isNonEmptyString(button[required])) {
        return `informe "${at}.${required}" (obrigatório no botão "${button.type}")`
      }
    }
  }

  const hasReply = buttons.some((b) => b.type === 'reply')
  const hasPix = buttons.some((b) => b.type === 'pix')
  const hasCta = buttons.some((b) => CTA_TYPES.includes(b.type))

  if (hasReply) {
    if (buttons.length > 3) return 'máximo de 3 botões "reply"'
    if (hasCta || hasPix) return 'botões "reply" não podem ser misturados com CTA ("url", "call", "copy") ou "pix"'
  }
  if (hasPix) {
    if (buttons.length > 1) return 'só é permitido um botão "pix", e sozinho'
    // A mensagem de PIX vai só com o nativeFlowMessage (sem body/footer/header),
    // igual à Evolution — recusamos em vez de ignorar esses campos em silêncio.
    for (const field of ['footer', 'thumbnailUrl', 'headerText']) {
      if (body[field]) return `"${field}" não é suportado junto com botão "pix"`
    }
    return null
  }
  if (hasCta && buttons.length > 2) return 'máximo de 2 botões de CTA ("url", "call", "copy")'

  return null
}

// Corpo no formato da Evolution: "title" em negrito e "description" abaixo.
// Qualquer um dos dois pode faltar; sem nenhum, a mensagem vai sem corpo.
function buildBodyText({ title, description }) {
  const parts = [title ? `*${title}*` : '', description || ''].filter(Boolean)
  return parts.length ? parts.join('\n\n') : null
}

// Monta o proto dos botões a partir de um payload JÁ validado por
// validateButtonsPayload. imageMessage é o cabeçalho com imagem opcional, já
// enviado pro servidor de mídia (resultado de prepareWAMessageMedia).
export function buildButtonsMessage(body, imageMessage) {
  const buttons = body.buttons ?? []
  const nativeFlowMessage = {
    // Sem botões vai a lista vazia — mesma estrutura do caso com botões, e
    // renderiza normalmente (cabeçalho/corpo/rodapé) num aparelho real.
    buttons: buttons.map((button) => ({
      name: NATIVE_FLOW_NAMES[button.type],
      buttonParamsJson: toButtonParamsJson(button)
    })),
    messageParamsJson: JSON.stringify({ from: 'api', templateId: crypto.randomUUID() })
  }

  if (buttons[0]?.type === 'pix') {
    return { interactiveMessage: { nativeFlowMessage } }
  }

  let header
  if (imageMessage) header = { hasMediaAttachment: true, imageMessage }
  else if (body.headerText) header = { title: body.headerText, hasMediaAttachment: false }

  const bodyText = buildBodyText(body)

  // Sem o wrapper viewOnceMessage que a Evolution usava no 2.3.x: segundo o
  // commit 35a4bd44 ele impede a renderização no WhatsApp Web/Desktop.
  // Cada parte é omitida quando vazia; "footer" é o rodapé.
  return {
    interactiveMessage: {
      header,
      body: bodyText ? { text: bodyText } : undefined,
      footer: body.footer ? { text: body.footer } : undefined,
      nativeFlowMessage
    }
  }
}
