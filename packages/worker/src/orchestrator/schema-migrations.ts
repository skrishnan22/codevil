const CURRENT_SCHEMA_VERSION = 2;

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

export function runOrchestratorSchemaMigrations(sql: SqlStorage): void {
  const version = getSchemaVersion(sql);
  if (version < 1) migrateToV1(sql);
  if (version < 2) migrateToV2(sql);
  if (version < CURRENT_SCHEMA_VERSION) {
    setSchemaVersion(sql, CURRENT_SCHEMA_VERSION);
  }
}
