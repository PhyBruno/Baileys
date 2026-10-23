import pg from 'pg'
import fs from 'fs'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/whatsapp_bridge',
  // Muitos Postgres gerenciados (RDS, Supabase, Render, etc.) exigem SSL.
  // rejectUnauthorized: false porque esses provedores costumam usar
  // certificados que não validam contra a CA padrão do Node.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
})

export async function migrate() {
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf-8')
  await pool.query(sql)
}

// Callbacks registrados com afterCommit() por transação em andamento.
const commitHooks = new WeakMap()

// Roda fn(client) dentro de BEGIN/COMMIT num client dedicado do pool. Em
// erro faz ROLLBACK e relança. Usado pra gravar a mensagem e criar as
// entregas de webhook juntas: ou as duas coisas acontecem, ou nenhuma.
export async function withTransaction(fn) {
  const client = await pool.connect()
  const hooks = []
  commitHooks.set(client, hooks)
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    commitHooks.delete(client)
    for (const hook of hooks) {
      try {
        hook()
      } catch (err) {
        console.error('afterCommit falhou:', err)
      }
    }
    return result
  } catch (err) {
    commitHooks.delete(client)
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Agenda fn pra depois do COMMIT da transação do client. Existe pra acordar o
// dispatcher de webhooks só quando a entrega já está visível pra outras
// conexões — acordado antes, ele não acha a linha e o aviso só sairia no
// próximo polling. Fora de transação (client = pool), roda em seguida.
export function afterCommit(client, fn) {
  const hooks = commitHooks.get(client)
  if (hooks) hooks.push(fn)
  else queueMicrotask(fn)
}
