CREATE TABLE IF NOT EXISTS session_idempotency (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_session_idempotency_session_id
  ON session_idempotency(session_id);
