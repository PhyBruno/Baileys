import { useEffect, useMemo, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useFieldArray, useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  createWebhook,
  MASKED_HEADER_VALUE,
  MAX_WEBHOOK_HEADERS,
  updateWebhook,
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookInput,
} from '@/lib/api'
import { WEBHOOK_EVENT_INFO } from '@/lib/labels'

// Nome de header válido segundo a RFC 9110 (token).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Monta o schema; `savedHeaderNames` são os headers já gravados (valor mascarado). */
function buildSchema(savedHeaderNames: string[]) {
  const saved = new Set(savedHeaderNames.map((name) => name.toLowerCase()))

  return z.object({
    url: z
      .string()
      .trim()
      .min(1, 'Informe a URL do webhook.')
      .max(2048, 'A URL pode ter no máximo 2048 caracteres.')
      .refine(isHttpUrl, 'Informe uma URL válida começando com http:// ou https://.'),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Selecione pelo menos um evento.'),
    enabled: z.boolean(),
    base64: z.boolean(),
    byEvents: z.boolean(),
    includeFromMe: z.boolean(),
    headers: z
      .array(
        z.object({
          name: z
            .string()
            .trim()
            .min(1, 'Informe o nome do header.')
            .max(256, 'Nome de header muito longo.')
            .regex(HEADER_NAME_RE, 'Nome de header inválido (use letras, números e - _ .).'),
          value: z
            .string()
            .min(1, 'Informe o valor do header.')
            .refine((v) => !/[\r\n]/.test(v), 'O valor não pode ter quebra de linha.'),
        }),
      )
      .max(MAX_WEBHOOK_HEADERS, `No máximo ${MAX_WEBHOOK_HEADERS} headers.`)
      .superRefine((rows, ctx) => {
        const seen = new Set<string>()
        rows.forEach((row, index) => {
          const key = row.name.trim().toLowerCase()
          if (key && seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'name'],
              message: 'Header repetido.',
            })
          }
          seen.add(key)
          // "••••" só mantém o valor salvo se o header continuar com o mesmo nome.
          if (row.value === MASKED_HEADER_VALUE && !saved.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'value'],
              message: 'Informe o valor: não há valor salvo para este nome de header.',
            })
          }
        })
      }),
  })
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>

function toFormValues(webhook?: Webhook | null): FormValues {
  if (!webhook) {
    return {
      url: '',
      events: ['MESSAGES_UPSERT'],
      enabled: true,
      base64: false,
      byEvents: false,
      includeFromMe: false,
      headers: [],
    }
  }
  return {
    url: webhook.url,
    events: webhook.events.length > 0 ? [...webhook.events] : ['MESSAGES_UPSERT'],
    enabled: webhook.enabled,
    base64: webhook.base64,
    byEvents: webhook.byEvents,
    includeFromMe: webhook.includeFromMe,
    headers: Object.entries(webhook.headers ?? {}).map(([name, value]) => ({ name, value })),
  }
}

function toInput(values: FormValues): WebhookInput {
  return {
    url: values.url.trim(),
    events: WEBHOOK_EVENTS.filter((ev) => values.events.includes(ev)),
    enabled: values.enabled,
    base64: values.base64,
    byEvents: values.byEvents,
    includeFromMe: values.includeFromMe,
    headers: Object.fromEntries(values.headers.map((h) => [h.name.trim(), h.value])),
  }
}

interface WebhookFormProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Webhook em edição; ausente para criar um novo. */
  webhook?: Webhook | null
}

/** Dialog de criação (POST) e edição (PUT, substituição completa) de webhook. */
export function WebhookForm({ sessionId, open, onOpenChange, webhook }: WebhookFormProps) {
  const queryClient = useQueryClient()
  const isEdit = Boolean(webhook)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // O componente é remontado por webhook (key no WebhookList), então o schema
  // calculado na montagem corresponde aos headers salvos deste webhook.
  const resolver = useMemo(
    () => zodResolver(buildSchema(Object.keys(webhook?.headers ?? {}))),
    [webhook],
  )
  const form = useForm<FormValues>({
    resolver,
    defaultValues: toFormValues(webhook),
  })
  const headers = useFieldArray({ control: form.control, name: 'headers' })

  // Recarrega os valores sempre que o Dialog abre ou o webhook muda.
  useEffect(() => {
    if (open) {
      form.reset(toFormValues(webhook))
      setSubmitError(null)
    }
  }, [open, webhook, form])

  const mutation = useMutation({
    mutationFn: (input: WebhookInput) =>
      webhook ? updateWebhook(sessionId, webhook.id, input) : createWebhook(sessionId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', sessionId] })
      toast.success(isEdit ? 'Webhook atualizado.' : 'Webhook criado.')
      onOpenChange(false)
    },
    onError: (err: Error) => {
      setSubmitError(err.message)
      toast.error(isEdit ? 'Não foi possível salvar o webhook.' : 'Não foi possível criar o webhook.', {
        description: err.message,
      })
    },
  })

  const onSubmit = form.handleSubmit((values) => {
    setSubmitError(null)
    mutation.mutate(toInput(values))
  })

  const headersError = form.formState.errors.headers?.root?.message ?? form.formState.errors.headers?.message

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar webhook' : 'Novo webhook'}</DialogTitle>
          <DialogDescription>
            Os avisos são enviados por POST em JSON, no formato de webhook da Evolution API.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-6" noValidate>
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>URL</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://exemplo.com.br/webhooks/wsb"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <SwitchRow
                    label="Ativo"
                    description="Webhooks inativos não recebem avisos."
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="base64"
                render={({ field }) => (
                  <SwitchRow
                    label="Incluir mídia (base64)"
                    description="Embute o arquivo de imagem, áudio, vídeo, documento ou sticker no aviso."
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="byEvents"
                render={({ field }) => (
                  <SwitchRow
                    label="URL por evento"
                    description="Acrescenta o evento ao fim da URL (ex.: /messages-upsert)."
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="includeFromMe"
                render={({ field }) => (
                  <SwitchRow
                    label="Incluir mensagens enviadas pelo celular"
                    description="Envia em messages.upsert as mensagens mandadas pelo próprio aparelho."
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="events"
              render={({ field }) => (
                <FormItem className="space-y-3">
                  <div className="space-y-1">
                    <FormLabel>Eventos</FormLabel>
                    <FormDescription>Escolha quais eventos são enviados para esta URL.</FormDescription>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {WEBHOOK_EVENTS.map((event) => {
                      const checked = field.value.includes(event)
                      const id = `event-${event}`
                      return (
                        <label
                          key={event}
                          htmlFor={id}
                          className="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-muted/40"
                        >
                          <Checkbox
                            id={id}
                            checked={checked}
                            onCheckedChange={(value) =>
                              field.onChange(
                                value
                                  ? [...field.value, event]
                                  : field.value.filter((ev) => ev !== event),
                              )
                            }
                            className="mt-0.5"
                          />
                          <span className="space-y-0.5">
                            <span className="block text-sm font-medium leading-none">
                              {WEBHOOK_EVENT_INFO[event].title}
                            </span>
                            <span className="block font-mono text-[11px] text-muted-foreground">{event}</span>
                            <span className="block text-xs text-muted-foreground">
                              {WEBHOOK_EVENT_INFO[event].description}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">Headers personalizados</p>
                  <p className="text-[0.8rem] text-muted-foreground">
                    Enviados em toda requisição (ex.: Authorization). Até {MAX_WEBHOOK_HEADERS}.
                    {isEdit && ` Valores salvos aparecem como ${MASKED_HEADER_VALUE}; deixe assim para mantê-los.`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={headers.fields.length >= MAX_WEBHOOK_HEADERS}
                  onClick={() => headers.append({ name: '', value: '' })}
                >
                  <Plus />
                  Adicionar header
                </Button>
              </div>

              {headers.fields.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">
                  Nenhum header personalizado.
                </p>
              ) : (
                <div className="space-y-2">
                  {headers.fields.map((row, index) => (
                    <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
                      <FormField
                        control={form.control}
                        name={`headers.${index}.name`}
                        render={({ field }) => (
                          <FormItem className="space-y-1">
                            <FormLabel className="sr-only">Nome do header {index + 1}</FormLabel>
                            <FormControl>
                              <Input placeholder="Nome (ex.: Authorization)" autoComplete="off" spellCheck={false} {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`headers.${index}.value`}
                        render={({ field }) => (
                          <FormItem className="space-y-1">
                            <FormLabel className="sr-only">Valor do header {index + 1}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="Valor"
                                autoComplete="off"
                                spellCheck={false}
                                onFocus={(e) => {
                                  // Facilita substituir o valor mascarado: seleciona tudo ao focar.
                                  if (e.target.value === MASKED_HEADER_VALUE) e.target.select()
                                }}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => headers.remove(index)}
                        aria-label={`Remover header ${index + 1}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {headersError && <p className="text-[0.8rem] font-medium text-destructive">{headersError}</p>}
            </div>

            {submitError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {submitError}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="animate-spin" />}
                {isEdit ? 'Salvar alterações' : 'Criar webhook'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

interface SwitchRowProps {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

/** Linha com Switch e descrição, no padrão de "item de configuração" do shadcn. */
function SwitchRow({ label, description, checked, onCheckedChange }: SwitchRowProps) {
  return (
    <FormItem className="flex flex-row items-start justify-between gap-4 space-y-0 rounded-md border p-3">
      <div className="space-y-1">
        <FormLabel className="leading-snug">{label}</FormLabel>
        <FormDescription>{description}</FormDescription>
      </div>
      <FormControl>
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
      </FormControl>
    </FormItem>
  )
}
