import { BufferJSON, initAuthCreds, proto } from 'baileys'
import { pool } from './db.js'

/**
 * Equivalente ao useMultiFileAuthState do Baileys, mas guardando cada
 * "arquivo" como uma linha na tabela wa_auth_state em vez de um arquivo em disco.
 * Isso permite rodar a bridge sem depender de disco persistente e consultar
 * o estado das sessões via SQL se precisar.
 */
export async function usePostgresAuthState(sessionId) {
  const readData = async (key) => {
    const { rows } = await pool.query(
      'SELECT value FROM wa_auth_state WHERE session_id = $1 AND key = $2',
      [sessionId, key]
    )
    if (!rows.length) return null
    return JSON.parse(rows[0].value, BufferJSON.reviver)
  }

  const writeData = async (key, data) => {
    const value = JSON.stringify(data, BufferJSON.replacer)
    await pool.query(
      `INSERT INTO wa_auth_state (session_id, key, value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (session_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [sessionId, key, value]
    )
  }

  const removeData = async (key) => {
    await pool.query('DELETE FROM wa_auth_state WHERE session_id = $1 AND key = $2', [sessionId, key])
  }

  const creds = (await readData('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}`
              tasks.push(value ? writeData(key, value) : removeData(key))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  }
}

/** Remove toda a linha de credenciais/chaves de uma sessão (logout definitivo). */
export async function wipeAuthState(sessionId) {
  await pool.query('DELETE FROM wa_auth_state WHERE session_id = $1', [sessionId])
}
