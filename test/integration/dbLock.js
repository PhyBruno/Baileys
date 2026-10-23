// Os arquivos de teste rodam em processos paralelos, mas os testes de
// integração dividem o mesmo banco, e o claim do dispatcher pega entregas
// pendentes de qualquer sessão. Um advisory lock do Postgres faz cada arquivo
// de integração esperar o anterior terminar.
const LOCK_ID = 7_310_001

export async function lockDatabase(pool) {
  const client = await pool.connect()
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
  return async () => {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
}
