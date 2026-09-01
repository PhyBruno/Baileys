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
