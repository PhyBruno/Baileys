import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Inbox, Loader2, RefreshCw } from 'lucide-react'

import { DeliveryStatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DELIVERY_STATUSES, listDeliveries, type DeliveryStatus } from '@/lib/api'
import { DELIVERY_STATUS_LABELS } from '@/lib/labels'
import { formatDateTime } from '@/lib/utils'

const PAGE_SIZE = 50
const REFRESH_MS = 5_000

type StatusFilter = 'all' | DeliveryStatus

interface DeliveriesTableProps {
  sessionId: string
  webhookId: string
}

/** Histórico de entregas de um webhook, com filtro de situação e "Carregar mais". */
export function DeliveriesTable({ sessionId, webhookId }: DeliveriesTableProps) {
  const [status, setStatus] = useState<StatusFilter>('all')

  const query = useInfiniteQuery({
    queryKey: ['deliveries', sessionId, webhookId, status],
    queryFn: ({ pageParam, signal }) =>
      listDeliveries(
        sessionId,
        webhookId,
        {
          status: status === 'all' ? undefined : status,
          limit: PAGE_SIZE,
          before: pageParam,
        },
        signal,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    // Atualiza a cada 5 s só enquanto a aba do navegador está visível.
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  })

  const items = query.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full space-y-1.5 sm:w-56">
          <Label htmlFor="delivery-status">Situação</Label>
          <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
            <SelectTrigger id="delivery-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {DELIVERY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {DELIVERY_STATUS_LABELS[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className={query.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden />
          Atualiza a cada 5 s com a aba aberta
        </div>
      </div>

      {query.isPending ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando entregas…
        </div>
      ) : query.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Não foi possível carregar as entregas: {query.error.message}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
          <Inbox className="h-8 w-8" aria-hidden />
          {status === 'all'
            ? 'Nenhuma entrega registrada para este webhook.'
            : 'Nenhuma entrega com esta situação.'}
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Evento</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Tentativas</TableHead>
                  <TableHead className="text-right">Último código</TableHead>
                  <TableHead>Último erro</TableHead>
                  <TableHead>Criada em</TableHead>
                  <TableHead>Entregue em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{delivery.event}</TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <DeliveryStatusBadge status={delivery.status} />
                        {delivery.status === 'pending' && delivery.nextAttemptAt && (
                          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                            próxima: {formatDateTime(delivery.nextAttemptAt)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{delivery.attempts}</TableCell>
                    <TableCell className="text-right tabular-nums">{delivery.lastStatusCode ?? '—'}</TableCell>
                    <TableCell className="max-w-[16rem]">
                      {delivery.lastError ? (
                        <span className="block truncate text-destructive" title={delivery.lastError}>
                          {delivery.lastError}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(delivery.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(delivery.deliveredAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {items.length} {items.length === 1 ? 'entrega exibida' : 'entregas exibidas'}
            </span>
            {query.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage && <Loader2 className="animate-spin" />}
                Carregar mais
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
