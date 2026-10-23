import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { ApiError, setApiKey as setClientApiKey, setUnauthorizedHandler, validateApiKey } from '@/lib/api'

// A API key fica só no sessionStorage (FR-025): some ao fechar a aba e nunca
// vai para localStorage, URL ou console.
const STORAGE_KEY = 'wsb.manager.apiKey'

function readStoredKey(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredKey(key: string | null) {
  try {
    if (key) window.sessionStorage.setItem(STORAGE_KEY, key)
    else window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // sessionStorage indisponível (modo restrito): a key vale só em memória.
  }
}

// Carrega a key antes da primeira renderização, para que as consultas
// disparadas pelos componentes filhos já saiam com o header.
const initialKey = readStoredKey()
setClientApiKey(initialKey)

interface AuthContextValue {
  isAuthenticated: boolean
  /** Valida a key com `GET /sessions` e, se aceita, guarda na aba. */
  login: (key: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const [apiKey, setApiKeyState] = useState<string | null>(initialKey)

  const logout = useCallback(() => {
    writeStoredKey(null)
    setClientApiKey(null)
    setApiKeyState(null)
    // Descarta tudo o que foi carregado com a key anterior.
    queryClient.cancelQueries()
    queryClient.clear()
  }, [queryClient])

  const login = useCallback(async (key: string) => {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('Informe a API Key.')
    try {
      await validateApiKey(trimmed)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw new Error('API Key inválida')
      throw err
    }
    writeStoredKey(trimmed)
    setClientApiKey(trimmed)
    setApiKeyState(trimmed)
  }, [])

  // Um 401 em qualquer chamada leva de volta ao login.
  useEffect(() => {
    setUnauthorizedHandler(logout)
    return () => setUnauthorizedHandler(null)
  }, [logout])

  const value = useMemo<AuthContextValue>(
    () => ({ isAuthenticated: apiKey !== null, login, logout }),
    [apiKey, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>')
  return ctx
}
