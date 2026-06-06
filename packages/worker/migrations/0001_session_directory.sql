CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  plan_model TEXT NOT NULL,
  exec_model TEXT NOT NULL,
  max_cost TEXT NOT NULL,
  max_session_time TEXT NOT NULL,
  max_idle_time TEXT NOT NULL,
  max_steps INTEGER NOT NULL,
  room_state TEXT NOT NULL,
  sandbox_state TEXT NOT NULL,
  active_run_state TEXT,
  created_by_id TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at
  ON sessions(last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_room_state
  ON sessions(room_state);
