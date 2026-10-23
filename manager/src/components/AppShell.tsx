import { LogOut, MessageSquareShare } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'

/** Moldura das telas autenticadas: cabeçalho com o botão "Sair" sempre visível. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="container flex h-14 items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <MessageSquareShare className="h-5 w-5 text-success" aria-hidden />
            <span>WSB Manager</span>
          </Link>
          <Button variant="outline" size="sm" onClick={logout}>
            <LogOut />
            Sair
          </Button>
        </div>
      </header>
      <main className="container flex-1 py-6">{children}</main>
    </div>
  )
}
