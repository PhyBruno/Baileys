import type { BadgeProps } from '@/components/ui/badge'
import type { DeliveryStatus, SessionStatus, WebhookEvent } from '@/lib/api'

type BadgeVariant = NonNullable<BadgeProps['variant']>

/** Rótulo e cor do Badge para cada status de instância. */
export const SESSION_STATUS_LABELS: Record<SessionStatus, { label: string; variant: BadgeVariant }> = {
  connected: { label: 'Conectada', variant: 'success' },
  connecting: { label: 'Conectando', variant: 'info' },
  qr: { label: 'Aguardando QR Code', variant: 'warning' },
  reconnecting: { label: 'Reconectando', variant: 'warning' },
  disconnected: { label: 'Desconectada', variant: 'secondary' },
  logged_out: { label: 'Deslogada', variant: 'outline' },
  error: { label: 'Erro', variant: 'destructive' },
}

/** Rótulo e cor do Badge para cada situação de entrega. */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: 'Pendente', variant: 'warning' },
  delivering: { label: 'Enviando', variant: 'info' },
  delivered: { label: 'Entregue', variant: 'success' },
  failed: { label: 'Falhou', variant: 'destructive' },
}

/** Descrição curta de cada evento, exibida no formulário de webhook. */
export const WEBHOOK_EVENT_INFO: Record<WebhookEvent, { title: string; description: string }> = {
  MESSAGES_UPSERT: {
    title: 'Mensagem recebida',
    description: 'Mensagens novas que chegam na instância (messages.upsert).',
  },
  SEND_MESSAGE: {
    title: 'Mensagem enviada pela API',
    description: 'Mensagens enviadas pelas rotas de envio do WSB (send.message).',
  },
  MESSAGES_UPDATE: {
    title: 'Status de mensagem',
    description: 'Entregue, lida ou reproduzida (messages.update).',
  },
  MESSAGES_EDITED: {
    title: 'Mensagem editada',
    description: 'Edição de uma mensagem já enviada (messages.edited).',
  },
  MESSAGES_DELETE: {
    title: 'Mensagem apagada',
    description: 'Mensagem apagada para todos (messages.delete).',
  },
  CONNECTION_UPDATE: {
    title: 'Conexão',
    description: 'Instância conectada, conectando ou desconectada (connection.update).',
  },
  QRCODE_UPDATED: {
    title: 'QR Code',
    description: 'Novo QR Code gerado para parear o aparelho (qrcode.updated).',
  },
}
