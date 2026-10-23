import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, History, Loader2, Webhook as WebhookIcon } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { AppShell } from '@/components/AppShell'
import { DeliveriesTable } from '@/components/DeliveriesTable'
import { SessionStatusBadge } from '@/components/StatusBadge'
import { WebhookList } from '@/components/WebhookList'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getSettings, listSessions, listWebhooks, updateSettings, type Settings } from '@/lib/api'

type TabValue = 'webhooks' | 'entregas'

/** Configuração de uma instância: ignorar grupos, webhooks e histórico de entregas. */
export default function Instance() {
  const { id = '' } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabValue>('webhooks')
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(null)

  // Reaproveita a lista de instâncias para mostrar nome e status no cabeçalho.
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => listSessions(signal),
    refetchInterval: 15_000,
  })
  const session = sessionsQuery.data?.find((s) => s.id === id)

  const settingsKey = ['settings', id]
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getSettings(id, signal),
    enabled: Boolean(id),
  })

  const settingsMutation = useMutation({
    mutationFn: (settings: Settings) => updateSettings(id, settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsKey, settings)
      toast.success(
        settings.groupsIgnore
          ? 'Mensagens de grupos passam a ser ignoradas.'
          : 'Mensagens de grupos passam a ser recebidas.',
      )
    },
    onError: (err: Error) =>
      toast.error('Não foi possível salvar a configuração.', { description: err.message }),
  })

  // Mesma consulta do WebhookList (mesma chave): alimenta o seletor da aba "Entregas".
  const webhooksQuery = useQuery({
    queryKey: ['webhooks', id],
    queryFn: ({ signal }) => listWebhooks(id, signal),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  })
  const webhooks = webhooksQuery.data ?? []

  // Mantém um webhook válido selecionado na aba "Entregas".
  useEffect(() => {
    if (!webhooksQuery.data) return
    const exists = webhooksQuery.data.some((w) => w.id === selectedWebhookId)
    if (!exists) setSelectedWebhookId(webhooksQuery.data[0]?.id ?? null)
  }, [webhooksQuery.data, selectedWebhookId])

  function showDeliveries(webhookId: string) {
    setSelectedWebhookId(webhookId)
    setTab('entregas')
  }

  const groupsIgnore = settingsMutation.isPending
    ? settingsMutation.variables.groupsIgnore
    : settingsQuery.data?.groupsIgnore

  const sessionMissing = sessionsQuery.isSuccess && !session

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="space-y-3">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Instâncias
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{id}</h1>
            {session && <SessionStatusBadge status={session.status} />}
          </div>
          {session?.name && <p className="text-muted-foreground">{session.name}</p>}
          {sessionMissing && (
            <p className="text-sm text-destructive">Esta instância não aparece na lista de sessões.</p>
          )}
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Configurações</CardTitle>
            <CardDescription>Valem imediatamente para as próximas mensagens.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-start justify-between gap-4 rounded-md border p-4">
              <div className="space-y-1">
                <Label htmlFor="groups-ignore" className="text-sm font-medium">
                  Ignorar grupos
                </Label>
                <p className="text-sm text-muted-foreground">
                  Quando ligado, mensagens de grupos não são gravadas nem enviadas aos webhooks.
                </p>
                {settingsQuery.isError && (
                  <p className="text-sm text-destructive">
                    Não foi possível carregar: {settingsQuery.error.message}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(settingsQuery.isPending || settingsMutation.isPending) && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
                )}
                <Switch
                  id="groups-ignore"
                  checked={groupsIgnore ?? false}
                  disabled={!settingsQuery.isSuccess || settingsMutation.isPending}
                  onCheckedChange={(checked) => settingsMutation.mutate({ groupsIgnore: checked })}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
          <TabsList>
            <TabsTrigger value="webhooks">
              <WebhookIcon />
              Webhooks
            </TabsTrigger>
            <TabsTrigger value="entregas">
              <History />
              Entregas
            </TabsTrigger>
          </TabsList>

          <TabsContent value="webhooks" className="mt-4">
            <WebhookList sessionId={id} onShowDeliveries={showDeliveries} />
          </TabsContent>

          <TabsContent value="entregas" className="mt-4">
            <Card>
              <CardHeader className="pb-4">
                <CardTitle>Histórico de entregas</CardTitle>
                <CardDescription>
                  Cada aviso enfileirado para o webhook, com as tentativas e o resultado.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {webhooksQuery.isPending ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Carregando webhooks…
                  </div>
                ) : webhooks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Cadastre um webhook na aba "Webhooks" para acompanhar as entregas.
                  </p>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-webhook">Webhook</Label>
                      <Select
                        value={selectedWebhookId ?? undefined}
                        onValueChange={(value) => setSelectedWebhookId(value)}
                      >
                        <SelectTrigger id="delivery-webhook" className="w-full md:max-w-xl">
                          <SelectValue placeholder="Escolha um webhook" />
                        </SelectTrigger>
                        <SelectContent>
                          {webhooks.map((w) => (
                            <SelectItem key={w.id} value={w.id}>
                              <span className="font-mono text-xs">{w.url}</span>
                              {!w.enabled && <span className="ml-2 text-muted-foreground">(inativo)</span>}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedWebhookId && (
                      <DeliveriesTable
                        key={selectedWebhookId}
                        sessionId={id}
                        webhookId={selectedWebhookId}
                      />
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  )
}
