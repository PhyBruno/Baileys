import crypto from 'node:crypto'

// Cifra dos valores de cabeçalho dos webhooks (wa_webhooks.headers). Eles
// costumam ser o token do receptor (Authorization, jwt_key...), e um dump ou
// backup do banco não deve entregá-los em texto puro.
//
// Só os VALORES são cifrados: os nomes continuam legíveis porque a leitura
// (GET) precisa deles para devolver a máscara, e não são segredo. Formato de
// cada valor: "enc:v1:" + base64(iv[12] ‖ tag[16] ‖ cifra), AES-256-GCM. O
// nome do cabeçalho entra como dado autenticado (AAD): um valor cifrado não
// pode ser movido de um cabeçalho para outro sem a decifração falhar.

const PREFIX = 'enc:v1:'
const IV_BYTES = 12
const TAG_BYTES = 16

export class HeaderDecryptError extends Error {
  constructor(name) {
    super(
      `não foi possível decifrar o cabeçalho "${name}" do webhook: a chave mudou ` +
        '(API_KEY trocada sem WEBHOOK_HEADERS_KEY?). Cadastre o valor de novo.'
    )
    this.name = 'HeaderDecryptError'
    this.header = name
  }
}

/**
 * secret: WEBHOOK_HEADERS_KEY, ou a API_KEY quando ela não é definida. Qualquer
 * tamanho serve: a chave AES é derivada com HKDF-SHA256, com rótulo próprio,
 * então nunca é a API key em si.
 */
export function createHeaderCipher(secret) {
  if (!secret) throw new Error('createHeaderCipher: segredo vazio')
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, 'wsb-webhook-headers', 'v1', 32))

  const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX)

  function encryptValue(name, value) {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(name))
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }

  function decryptValue(name, value) {
    // Valor sem prefixo: gravado antes da cifra existir (texto puro legado).
    if (!isEncrypted(value)) return value
    try {
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
      decipher.setAAD(Buffer.from(name))
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch {
      throw new HeaderDecryptError(name)
    }
  }

  return {
    isEncrypted,
    /** { nome: valor } → { nome: "enc:v1:..." } (valor já cifrado não é cifrado de novo). */
    encryptHeaders(headers) {
      return Object.fromEntries(
        Object.entries(headers ?? {}).map(([name, value]) => [name, isEncrypted(value) ? value : encryptValue(name, value)])
      )
    },
    /** Inverso de encryptHeaders. Lança HeaderDecryptError se a chave não bate. */
    decryptHeaders(headers) {
      return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name, decryptValue(name, value)]))
    },
    /** Há algum valor ainda em texto puro? (migração no boot) */
    hasPlaintext(headers) {
      return Object.values(headers ?? {}).some((value) => !isEncrypted(value))
    }
  }
}
