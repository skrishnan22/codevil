CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  repo TEXT NOT NULL,
  cache_version TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  backup_dir TEXT NOT NULL,
  backup_local_bucket INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_latest
  ON workspace_snapshots(repo_key, cache_version, status, created_at DESC);
