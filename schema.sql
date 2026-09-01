-- Metadados de cada sessão (um número de WhatsApp conectado à bridge)
CREATE TABLE IF NOT EXISTS wa_sessions (
  id         TEXT PRIMARY KEY,           -- número normalizado (só dígitos, com DDI), ex: 5511999999999
  status     TEXT NOT NULL DEFAULT 'connecting',
  jid        TEXT,                        -- jid completo que o WhatsApp confirma ao conectar
  name       TEXT,                        -- push name / nome de perfil do WhatsApp confirmado ao conectar
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessões criadas antes da coluna "name" existir não têm essa coluna até a
-- migração rodar de novo; ALTER TABLE ... ADD COLUMN IF NOT EXISTS cobre o
-- upgrade de um banco já existente (CREATE TABLE IF NOT EXISTS acima não
-- altera uma tabela que já existe).
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS name TEXT;

-- Credenciais e chaves de sinal do Baileys, uma linha por chave (equivalente a um
-- arquivo por chave no useMultiFileAuthState, só que em Postgres).
CREATE TABLE IF NOT EXISTS wa_auth_state (
  session_id TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,               -- 'creds' ou '<tipo>-<id>', ex: 'pre-key-3'
  value      TEXT NOT NULL,                -- JSON serializado (BufferJSON.replacer)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);
