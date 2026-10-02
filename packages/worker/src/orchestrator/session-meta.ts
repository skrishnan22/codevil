import type { SessionMeta } from "@codevil/shared";
import { SessionMetaSchema, emitValidationDrop, isRecord } from "@codevil/shared";
import type { SessionEventLog } from "./event-log.js";

export interface SessionMetaStore {
  meta: SessionMeta | null;
  eventLog: SessionEventLog;
}

export function saveSessionMeta(sql: SqlStorage, meta: SessionMeta | null): void {
  if (!meta) return;
  const validated = SessionMetaSchema.parse(meta);
  sql.exec(
    `INSERT OR REPLACE INTO session_meta (key, value) VALUES ('meta', ?)`,
    JSON.stringify(validated),
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
    let raw: unknown;
    try {
      raw = JSON.parse(r["value"] as string);
    } catch {
      emitValidationDrop("orchestrator", "session_meta", [
        { code: "custom", message: "Invalid JSON in session_meta row", path: [] },
      ]);
      break;
    }

    const parsed = SessionMetaSchema.safeParse(raw);
    if (!parsed.success) {
      emitValidationDrop("orchestrator", "session_meta", parsed.error.issues, {
        session_id: isRecord(raw) && typeof raw.session_id === "string" ? raw.session_id : undefined,
      });
      break;
    }

    store.meta = parsed.data;
    break;
  }

  store.eventLog.hydrateFromSql();
}
