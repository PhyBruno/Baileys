import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/auth'

/** Tela de entrada: só pede a API key; nenhum dado aparece antes da validação. */
export default function Login() {
  const { isAuthenticated, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const from = (location.state as { from?: string } | null)?.from
  const target = from && from !== '/login' ? from : '/'

  if (isAuthenticated) return <Navigate to={target} replace />

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(key)
      setKey('')
      navigate(target, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível validar a API Key.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KeyRound className="h-5 w-5" aria-hidden />
          </div>
          <CardTitle className="text-xl">WSB Manager</CardTitle>
          <CardDescription>
            Informe a API Key do servidor para configurar webhooks e instâncias.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="api-key">API Key</Label>
              <Input
                id="api-key"
                name="api-key"
                type="password"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  if (error) setError(null)
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'api-key-error' : 'api-key-hint'}
                disabled={submitting}
              />
              {error ? (
                <p id="api-key-error" role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              ) : (
                <p id="api-key-hint" className="text-xs text-muted-foreground">
                  A chave fica guardada só nesta aba e some ao fechá-la.
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={submitting || !key.trim()}>
              {submitting && <Loader2 className="animate-spin" />}
              {submitting ? 'Validando…' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
