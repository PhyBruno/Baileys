// Cliente HTTP da tela de configuração. Toda chamada envia a API key no header
// x-api-key (nunca na URL) e segue o contrato specs/.../contracts/rest-api.md.

// ---------------------------------------------------------------------------
// Tipos espelhando o contrato
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = [
  'connecting',
  'qr',
  'connected',
  'reconnecting',
  'disconnected',
  'logged_out',
  'error',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** Linha de `GET /sessions`. */
export interface Session {
  id: string
  status: SessionStatus | (string & {})
  jid: string | null
  name: string | null
  updated_at: string
}

/** Eventos aceitos por um webhook (contracts/webhook-payload.md). */
export const WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'SEND_MESSAGE',
  'MESSAGES_UPDATE',
  'MESSAGES_EDITED',
  'MESSAGES_DELETE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** Valor com que o backend mascara os headers salvos; reenviá-lo mantém o valor original. */
export const MASKED_HEADER_VALUE = '••••'

/** Limite de webhooks por instância imposto pelo backend. */
export const MAX_WEBHOOKS_PER_SESSION = 10

/** Limite de headers personalizados por webhook. */
export const MAX_WEBHOOK_HEADERS = 20

export const DELIVERY_STATUSES = ['pending', 'delivering', 'delivered', 'failed'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export interface LastDelivery {
  status: DeliveryStatus
  statusCode: number | null
  at: string
}

export interface Webhook {
  id: string
  url: string
  enabled: boolean
  events: WebhookEvent[]
  base64: boolean
  byEvents: boolean
  includeFromMe: boolean
  headers: Record<string, string>
  createdAt: string
  updatedAt: string
  lastDelivery: LastDelivery | null
}

/** Corpo de `POST` e `PUT` (substituição completa). */
export interface WebhookInput {
  url: string
  enabled: boolean
  events: WebhookEvent[]
  base64: boolean
  byEvents: boolean
  includeFromMe: boolean
  headers: Record<string, string>
}

export interface Delivery {
  id: number
  event: string
  status: DeliveryStatus
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  nextAttemptAt: string | null
  createdAt: string
  deliveredAt: string | null
  messageKeyId: string | null
}

export interface DeliveriesPage {
  items: Delivery[]
  nextBefore: number | null
}

export interface DeliveriesQuery {
  status?: DeliveryStatus
  limit?: number
  before?: number
}

export interface Settings {
  groupsIgnore: boolean
}

export interface WebhookTestResult {
  ok: boolean
  statusCode: number | null
  durationMs?: number
  error?: string
}

export interface WebhookRemoved {
  id: string
  status: 'removed'
}

// ---------------------------------------------------------------------------
// Estado de autenticação usado pelo cliente (alimentado por lib/auth.tsx)
// ---------------------------------------------------------------------------

let currentApiKey: string | null = null
let unauthorizedHandler: (() => void) | null = null

/** Define a API key enviada nas próximas chamadas (null depois do logout). */
export function setApiKey(key: string | null) {
  currentApiKey = key
}

/** Registra o que fazer quando a API responder 401 (normalmente, logout). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

/** Erro de API com o status HTTP; a mensagem é o campo `error` da resposta. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Usa esta key em vez da atual (validação no login). */
  apiKey?: string
  /** Não dispara o logout automático em 401 (validação no login). */
  skipUnauthorizedHandler?: boolean
  signal?: AbortSignal
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json()
    if (data && typeof data === 'object' && 'error' in data) {
      const message = (data as { error: unknown }).error
      if (typeof message === 'string' && message.trim()) return message
    }
  } catch {
    // Corpo vazio ou não-JSON: cai na mensagem genérica abaixo.
  }
  return `Erro HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ''}`
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const key = options.apiKey ?? currentApiKey
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (key) headers['x-api-key'] = key
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError('Não foi possível conectar ao servidor do WSB.', 0)
  }

  if (!res.ok) {
    const message = await readErrorMessage(res)
    if (res.status === 401 && !options.skipUnauthorizedHandler) {
      unauthorizedHandler?.()
    }
    throw new ApiError(message, res.status)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const enc = encodeURIComponent

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export function listSessions(signal?: AbortSignal) {
  return request<Session[]>('/sessions', { signal })
}

/** Valida uma API key sem afetar o estado atual (usado no login). */
export function validateApiKey(key: string) {
  return request<Session[]>('/sessions', { apiKey: key, skipUnauthorizedHandler: true })
}

export function getSettings(sessionId: string, signal?: AbortSignal) {
  return request<Settings>(`/sessions/${enc(sessionId)}/settings`, { signal })
}

export function updateSettings(sessionId: string, settings: Settings) {
  return request<Settings>(`/sessions/${enc(sessionId)}/settings`, {
    method: 'PATCH',
    body: settings,
  })
}

export function listWebhooks(sessionId: string, signal?: AbortSignal) {
  return request<Webhook[]>(`/sessions/${enc(sessionId)}/webhooks`, { signal })
}

export function createWebhook(sessionId: string, input: WebhookInput) {
  return request<Webhook>(`/sessions/${enc(sessionId)}/webhooks`, {
    method: 'POST',
    body: input,
  })
}

export function updateWebhook(sessionId: string, webhookId: string, input: WebhookInput) {
  return request<Webhook>(`/sessions/${enc(sessionId)}/webhooks/${enc(webhookId)}`, {
    method: 'PUT',
    body: input,
  })
}

export function deleteWebhook(sessionId: string, webhookId: string) {
  return request<WebhookRemoved>(`/sessions/${enc(sessionId)}/webhooks/${enc(webhookId)}`, {
    method: 'DELETE',
  })
}

export function testWebhook(sessionId: string, webhookId: string) {
  return request<WebhookTestResult>(
    `/sessions/${enc(sessionId)}/webhooks/${enc(webhookId)}/test`,
    { method: 'POST' },
  )
}

export function listDeliveries(
  sessionId: string,
  webhookId: string,
  query: DeliveriesQuery = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (query.status) params.set('status', query.status)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.before !== undefined) params.set('before', String(query.before))
  const qs = params.toString()
  return request<DeliveriesPage>(
    `/sessions/${enc(sessionId)}/webhooks/${enc(webhookId)}/deliveries${qs ? `?${qs}` : ''}`,
    { signal },
  )
}

/** Converte um webhook lido da API no corpo de PUT (headers continuam mascarados). */
export function webhookToInput(webhook: Webhook): WebhookInput {
  return {
    url: webhook.url,
    enabled: webhook.enabled,
    events: webhook.events,
    base64: webhook.base64,
    byEvents: webhook.byEvents,
    includeFromMe: webhook.includeFromMe,
    headers: { ...webhook.headers },
  }
}
