import { Badge } from '@/components/ui/badge'
import type { DeliveryStatus } from '@/lib/api'
import { DELIVERY_STATUS_LABELS, SESSION_STATUS_LABELS } from '@/lib/labels'

/** Badge do status da instância; status desconhecido aparece como veio da API. */
export function SessionStatusBadge({ status }: { status: string }) {
  const info = SESSION_STATUS_LABELS[status as keyof typeof SESSION_STATUS_LABELS]
  return <Badge variant={info?.variant ?? 'outline'}>{info?.label ?? status}</Badge>
}

/** Badge da situação de uma entrega de webhook. */
export function DeliveryStatusBadge({ status }: { status: DeliveryStatus | string }) {
  const info = DELIVERY_STATUS_LABELS[status as DeliveryStatus]
  return <Badge variant={info?.variant ?? 'outline'}>{info?.label ?? status}</Badge>
}
