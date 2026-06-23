import type { SessionMeta } from "./types.js";
import type { SessionEventLog } from "./event-log.js";

export interface SessionMetaStore {
  meta: SessionMeta | null;
  eventLog: SessionEventLog;
}

export function saveSessionMeta(sql: SqlStorage, meta: SessionMeta | null): void {
  if (!meta) return;
  sql.exec(
    `INSERT OR REPLACE INTO session_meta (key, value) VALUES ('meta', ?)`,
    JSON.stringify(meta),
  );
}

export function loadSessionMeta(
  sql: SqlStorage,
  store: SessionMetaStore,
): void {
  if (store.meta) return;
  const row = sql.exec(
    "SELECT value FROM session_meta WHERE key = 'meta'"
  );
  for (const r of row) {
    store.meta = JSON.parse(r["value"] as string);
    store.meta!.queued_runs ??= [];
    store.meta!.active_run ??= null;
    break;
  }

  store.eventLog.hydrateFromSql();
}
