import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Loader2, Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react'
import { toast } from 'sonner'

import { DeliveryStatusBadge } from '@/components/StatusBadge'
import { WebhookForm } from '@/components/WebhookForm'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  deleteWebhook,
  listWebhooks,
  MAX_WEBHOOKS_PER_SESSION,
  testWebhook,
  updateWebhook,
  webhookToInput,
  type Webhook,
} from '@/lib/api'
import { WEBHOOK_EVENT_INFO } from '@/lib/labels'
import { cn, formatDateTime } from '@/lib/utils'

interface WebhookListProps {
  sessionId: string
  /** Abre a aba "Entregas" já com este webhook selecionado. */
  onShowDeliveries: (webhookId: string) => void
}

/** Lista de webhooks da instância com ativar/desativar, editar, excluir e testar. */
export function WebhookList({ sessionId, onShowDeliveries }: WebhookListProps) {
  const queryClient = useQueryClient()
  const queryKey = ['webhooks', sessionId]

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Webhook | null>(null)
  const [deleting, setDeleting] = useState<Webhook | null>(null)

  const webhooksQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => listWebhooks(sessionId, signal),
    refetchInterval: 15_000,
  })

  // Ativar/desativar: PUT com o webhook completo (headers mascarados mantêm o valor salvo).
  const toggleMutation = useMutation({
    mutationFn: ({ webhook, enabled }: { webhook: Webhook; enabled: boolean }) =>
      updateWebhook(sessionId, webhook.id, { ...webhookToInput(webhook), enabled }),
    onMutate: async ({ webhook, enabled }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<Webhook[]>(queryKey)
      queryClient.setQueryData<Webhook[]>(queryKey, (list) =>
        list?.map((w) => (w.id === webhook.id ? { ...w, enabled } : w)),
      )
      return { previous }
    },
    onError: (err: Error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
      toast.error('Não foi possível alterar o webhook.', { description: err.message })
    },
    onSuccess: (_data, { enabled }) => {
      toast.success(enabled ? 'Webhook ativado.' : 'Webhook desativado.')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const testMutation = useMutation({
    mutationFn: (webhook: Webhook) => testWebhook(sessionId, webhook.id),
    onSuccess: (result) => {
      const details = [
        result.statusCode != null ? `HTTP ${result.statusCode}` : null,
        result.durationMs != null ? `${result.durationMs} ms` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      if (result.ok) {
        toast.success('Teste entregue com sucesso.', { description: details || undefined })
      } else {
        toast.error('O destino recusou o teste.', {
          description: [result.error, details].filter(Boolean).join(' · ') || undefined,
        })
      }
    },
    onError: (err: Error) => toast.error('Não foi possível testar o webhook.', { description: err.message }),
  })

  const deleteMutation = useMutation({
    mutationFn: (webhook: Webhook) => deleteWebhook(sessionId, webhook.id),
    onSuccess: () => {
      toast.success('Webhook excluído.')
      setDeleting(null)
      queryClient.invalidateQueries({ queryKey })
      queryClient.removeQueries({ queryKey: ['deliveries', sessionId] })
    },
    onError: (err: Error) => toast.error('Não foi possível excluir o webhook.', { description: err.message }),
  })

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(webhook: Webhook) {
    setEditing(webhook)
    setFormOpen(true)
  }

  const webhooks = webhooksQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            {webhooksQuery.isSuccess
              ? `${webhooks.length} de ${MAX_WEBHOOKS_PER_SESSION} webhooks cadastrados.`
              : `Até ${MAX_WEBHOOKS_PER_SESSION} webhooks por instância.`}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus />
          Novo webhook
        </Button>
      </div>

      {webhooksQuery.isPending ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando webhooks…
        </div>
      ) : webhooksQuery.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Não foi possível carregar os webhooks: {webhooksQuery.error.message}
        </div>
      ) : webhooks.length === 0 ? (
        <Card className="border-dashed shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <WebhookIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">Nenhum webhook cadastrado</p>
              <p className="text-sm text-muted-foreground">
                Cadastre uma URL para receber as mensagens desta instância.
              </p>
            </div>
            <Button variant="outline" onClick={openCreate}>
              <Plus />
              Cadastrar webhook
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {webhooks.map((webhook) => {
            const toggling = toggleMutation.isPending && toggleMutation.variables?.webhook.id === webhook.id
            const testing = testMutation.isPending && testMutation.variables?.id === webhook.id
            const headerCount = Object.keys(webhook.headers ?? {}).length
            return (
              <li key={webhook.id}>
                <Card className={cn('shadow-sm', !webhook.enabled && 'bg-muted/30')}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="break-all font-mono text-sm font-medium" title={webhook.url}>
                          {webhook.url}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {webhook.events.map((event) => (
                            <Badge key={event} variant="secondary" title={WEBHOOK_EVENT_INFO[event]?.description}>
                              {WEBHOOK_EVENT_INFO[event]?.title ?? event}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <label className="flex shrink-0 items-center gap-2 text-sm">
                        <span className={webhook.enabled ? 'text-foreground' : 'text-muted-foreground'}>
                          {webhook.enabled ? 'Ativo' : 'Inativo'}
                        </span>
                        <Switch
                          checked={webhook.enabled}
                          disabled={toggling}
                          onCheckedChange={(enabled) => toggleMutation.mutate({ webhook, enabled })}
                          aria-label={webhook.enabled ? 'Desativar webhook' : 'Ativar webhook'}
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Mídia em base64: {webhook.base64 ? 'sim' : 'não'}</span>
                      <span>URL por evento: {webhook.byEvents ? 'sim' : 'não'}</span>
                      <span>Enviadas pelo celular: {webhook.includeFromMe ? 'sim' : 'não'}</span>
                      <span>
                        Headers: {headerCount === 0 ? 'nenhum' : headerCount}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-muted-foreground">Última entrega:</span>
                        {webhook.lastDelivery ? (
                          <>
                            <DeliveryStatusBadge status={webhook.lastDelivery.status} />
                            {webhook.lastDelivery.statusCode != null && (
                              <span className="tabular-nums">HTTP {webhook.lastDelivery.statusCode}</span>
                            )}
                            <span className="text-muted-foreground">
                              {formatDateTime(webhook.lastDelivery.at)}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">nenhuma ainda</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => testMutation.mutate(webhook)}
                          disabled={testing}
                        >
                          {testing ? <Loader2 className="animate-spin" /> : <Send />}
                          Testar
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => onShowDeliveries(webhook.id)}>
                          <History />
                          Entregas
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => openEdit(webhook)}>
                          <Pencil />
                          Editar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleting(webhook)}
                        >
                          <Trash2 />
                          Excluir
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      <WebhookForm
        key={editing?.id ?? 'novo'}
        sessionId={sessionId}
        open={formOpen}
        onOpenChange={setFormOpen}
        webhook={editing}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir webhook?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block break-all font-mono text-foreground">{deleting?.url}</span>
              <span className="mt-2 block">
                O webhook deixa de receber avisos e as entregas pendentes dele são descartadas. Esta ação não
                pode ser desfeita.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                // Mantém o diálogo aberto até a API responder.
                event.preventDefault()
                if (deleting) deleteMutation.mutate(deleting)
              }}
            >
              {deleteMutation.isPending && <Loader2 className="animate-spin" />}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
