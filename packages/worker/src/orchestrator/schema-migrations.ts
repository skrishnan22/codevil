const CURRENT_SCHEMA_VERSION = 5;

function getSchemaVersion(sql: SqlStorage): number {
  const rows = sql.exec(
    "SELECT value FROM session_meta WHERE key = 'schema_version' LIMIT 1",
  ).toArray() as Array<{ value: string }>;
  const raw = rows[0]?.value;
  const version = raw ? Number(raw) : 0;
  return Number.isFinite(version) ? version : 0;
}

function setSchemaVersion(sql: SqlStorage, version: number): void {
  sql.exec(
    "INSERT INTO session_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(version),
  );
}

function hasColumn(sql: SqlStorage, table: string, column: string): boolean {
  const rows = sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function migrateToV1(sql: SqlStorage): void {
  if (!hasColumn(sql, "events", "path")) {
    sql.exec("ALTER TABLE events ADD COLUMN path TEXT NOT NULL DEFAULT 'session'");
  }
  sql.exec("CREATE INDEX IF NOT EXISTS idx_events_path_id ON events(path, id)");
}

function migrateToV2(sql: SqlStorage): void {
  if (!hasColumn(sql, "questions", "assigned_to_id")) {
    sql.exec("ALTER TABLE questions ADD COLUMN assigned_to_id TEXT");
  }
  if (!hasColumn(sql, "questions", "assigned_to_name")) {
    sql.exec("ALTER TABLE questions ADD COLUMN assigned_to_name TEXT");
  }
}

function migrateToV3(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS live_run_presentations (
    run_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_message_id TEXT,
    presentation_status TEXT NOT NULL,
    last_projected_cursor INTEGER NOT NULL DEFAULT 0,
    last_delivered_cursor INTEGER NOT NULL DEFAULT 0,
    last_render_fingerprint TEXT,
    pending_final_response_cursor INTEGER,
    next_retry_at INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS idx_live_run_presentations_retry ON live_run_presentations(next_retry_at)");
}

function migrateToV4(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS workspace_cache_jobs (
    job_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    cache_version TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    started_at INTEGER,
    snapshot_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS idx_workspace_cache_jobs_next_attempt ON workspace_cache_jobs(next_attempt_at)");
}

function migrateToV5(sql: SqlStorage): void {
  if (!hasColumn(sql, "live_run_presentations", "card_delete_pending_at")) {
    sql.exec("ALTER TABLE live_run_presentations ADD COLUMN card_delete_pending_at INTEGER");
  }
}

export function runOrchestratorSchemaMigrations(sql: SqlStorage): void {
  const version = getSchemaVersion(sql);
  if (version < 1) migrateToV1(sql);
  if (version < 2) migrateToV2(sql);
  if (version < 3) migrateToV3(sql);
  if (version < 4) migrateToV4(sql);
  if (version < 5) migrateToV5(sql);
  if (version < CURRENT_SCHEMA_VERSION) {
    setSchemaVersion(sql, CURRENT_SCHEMA_VERSION);
  }
}
