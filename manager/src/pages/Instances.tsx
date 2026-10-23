import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Loader2, RefreshCw, Smartphone } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { AppShell } from '@/components/AppShell'
import { SessionStatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listSessions } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'

/** Lista de instâncias (GET /sessions) com link para a configuração de cada uma. */
export default function Instances() {
  const navigate = useNavigate()
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => listSessions(signal),
    refetchInterval: 15_000,
  })

  const sessions = sessionsQuery.data ?? []

  return (
    <AppShell>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-xl">Instâncias</CardTitle>
            <CardDescription>
              Escolha uma instância para configurar webhooks, ignorar grupos e ver as entregas.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sessionsQuery.refetch()}
            disabled={sessionsQuery.isFetching}
          >
            <RefreshCw className={sessionsQuery.isFetching ? 'animate-spin' : undefined} />
            Atualizar
          </Button>
        </CardHeader>
        <CardContent>
          {sessionsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando instâncias…
            </div>
          ) : sessionsQuery.isError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              Não foi possível carregar as instâncias: {sessionsQuery.error.message}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <Smartphone className="h-8 w-8" aria-hidden />
              Nenhuma instância cadastrada. Crie uma pela API (POST /sessions).
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Nome de perfil</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Atualizada em</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Abrir</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow
                    key={session.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/instances/${encodeURIComponent(session.id)}`)}
                  >
                    <TableCell className="font-mono font-medium">
                      <Link
                        to={`/instances/${encodeURIComponent(session.id)}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {session.id}
                      </Link>
                    </TableCell>
                    <TableCell>{session.name || <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>
                      <SessionStatusBadge status={session.status} />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {formatDateTime(session.updated_at)}
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppShell>
  )
}
