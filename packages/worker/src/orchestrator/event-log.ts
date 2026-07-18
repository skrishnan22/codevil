import type { DOToCLIEvent } from "@codevil/shared";
import {
  applyToSessionSnapshot,
  DOToCLIEventSchema,
  emptySessionSnapshot,
  parseSessionSnapshot,
  safeExceptionAttributes,
  safeOwnDataProperty,
  safePrimitiveString,
  type ProjectionContext,
  type SessionSnapshot,
  type Tracer,
} from "@codevil/shared";
import { redactEvent } from "../redaction.js";
import { buildReplayBatch } from "../replay-batch.js";
import {
  capEventForStorage,
  capSessionSnapshotForStorage,
  EVENT_LOG_RETENTION_DAYS,
  eventJsonByteLength,
  prepareSnapshotCheckpoint,
  shouldCompactEventTail,
} from "./event-log-limits.js";

export class SessionEventLog {
  private snapshot: SessionSnapshot = emptySessionSnapshot();
  private snapshotCursor = 0;
  private snapshotDirty = false;
  private snapshotMessageCounter = 0;
  private snapshotHydrated = false;
  private snapshotAlarmScheduled = false;
  private lastPersistedSnapshot: SessionSnapshot = emptySessionSnapshot();
  private lastPersistedSnapshotCursor = 0;
  private eventsSincePersistedSnapshot = 0;

  constructor(
    private readonly sql: SqlStorage,
    private readonly getCliWebSockets: () => WebSocket[],
    private readonly scheduleAlarm: (when: number) => void,
    private readonly redactionSecrets: readonly string[],
    private readonly getTracer: () => Tracer | null,
    private readonly snapshotTerminalEventTypes: ReadonlySet<string>,
  ) {}

  getSnapshot(): SessionSnapshot {
    return prepareSnapshotCheckpoint(this.snapshot).canPersist
      ? this.snapshot
      : this.lastPersistedSnapshot;
  }

  getSnapshotCursor(): number {
    return prepareSnapshotCheckpoint(this.snapshot).canPersist
      ? this.snapshotCursor
      : this.lastPersistedSnapshotCursor;
  }

  isSnapshotDirty(): boolean {
    return this.snapshotDirty;
  }

  onAlarm(): void {
    this.snapshotAlarmScheduled = false;
    this.pruneExpiredEvents();
  }

  pruneExpiredEvents(): void {
    this.sql.exec(
      "DELETE FROM events WHERE created_at < datetime('now', ?)",
      `-${EVENT_LOG_RETENTION_DAYS} days`,
    );
  }

  appendAndBroadcast(event: DOToCLIEvent): number | null {
    const validated = DOToCLIEventSchema.safeParse(event);
    if (!validated.success) {
      this.getTracer()?.log("ERROR", "event.append.rejected", {
        raw_type: safePrimitiveString(
          safeOwnDataProperty(event, "type"),
        ),
        issues: validated.error.issues,
      });
      return null;
    }

    const redacted = redactEvent(validated.data, this.redactionSecrets);
    const capped = capEventForStorage(redacted);
    if (capped.truncated) {
      this.getTracer()?.log("WARN", "event.append.truncated", {
        raw_type: redacted.type,
        original_bytes: eventJsonByteLength(JSON.stringify(redacted)),
      });
    }

    const stored = capped.event;
    const json = JSON.stringify(stored);
    this.sql.exec("INSERT INTO events (event_json) VALUES (?)", json);

    const row = this.sql.exec(
      "SELECT id FROM events ORDER BY id DESC LIMIT 1"
    ).one() as { id: number };

    // Maintain in-memory snapshot. Reset counter to 0 so sub-indices are
    // deterministic per cursor (msg_<id>_0, msg_<id>_1, ...).
    this.snapshotMessageCounter = 0;
    const ctx: ProjectionContext = {
      uid: () => `msg_${row.id}_${this.snapshotMessageCounter++}`,
      now: Date.now(),
    };
    this.snapshot = capSessionSnapshotForStorage(
      applyToSessionSnapshot(this.snapshot, row.id, stored, ctx),
    );
    this.snapshotCursor = row.id;
    this.snapshotDirty = true;
    this.eventsSincePersistedSnapshot += 1;

    const envelope = JSON.stringify({ cursor: row.id, event: stored });
    for (const ws of this.getCliWebSockets()) {
      ws.send(envelope);
    }

    // Persist synchronously on terminal events; otherwise debounce via alarm.
    if (
      this.snapshotTerminalEventTypes.has(stored.type) ||
      shouldCompactEventTail(this.eventsSincePersistedSnapshot)
    ) {
      this.persistSnapshot();
    } else {
      this.scheduleSnapshotPersist();
    }
    return row.id;
  }

  persistSnapshot(): void {
    try {
      const prepared = prepareSnapshotCheckpoint(this.snapshot);
      if (!prepared.canPersist) {
        this.getTracer()?.log("WARN", "snapshot.persist.skipped", {
          reason: "snapshot_exceeds_storage_budget",
          bytes: eventJsonByteLength(JSON.stringify(prepared.snapshot)),
        });
        return;
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO snapshots (path, cursor, state_json, updated_at) VALUES (?, ?, ?, datetime('now'))",
        "session",
        this.snapshotCursor,
        JSON.stringify(prepared.snapshot),
      );
      this.lastPersistedSnapshot = prepared.snapshot;
      this.lastPersistedSnapshotCursor = this.snapshotCursor;
      this.eventsSincePersistedSnapshot = 0;
      this.snapshotDirty = false;
    } catch (error) {
      this.getTracer()?.log("ERROR", "snapshot.persist.failed", {
        ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
      });
      // Do NOT rethrow — persistence failure is recoverable on the next alarm.
    }
  }

  scheduleSnapshotPersist(): void {
    if (this.snapshotAlarmScheduled) return;
    this.snapshotAlarmScheduled = true;
    // 30s debounce — first dirty event after a quiet period arms the alarm.
    // This may bring forward an existing alarm scheduled by armNextAlarm; that
    // is safe because alarm() will call armNextAlarm() to reschedule as needed.
    this.scheduleAlarm(Date.now() + 30_000);
  }

  replayEvents(ws: WebSocket, afterCursor: number): void {
    // Schema re-validation skipped: rows were validated when written.
    const rows = this.sql.exec(
      "SELECT id, event_json FROM events WHERE id > ? ORDER BY id ASC",
      afterCursor,
    );
    const events = buildReplayBatch(
      (function* () {
        for (const row of rows) {
          yield { id: row["id"] as number, event_json: row["event_json"] as string };
        }
      })(),
    );
    ws.send(JSON.stringify({ type: "replay_batch", events }));
  }

  hydrateFromSql(): void {
    if (this.snapshotHydrated) return;
    // Set the guard before parsing so a corrupt row doesn't trigger infinite re-hydration attempts.
    // On parse failure we keep the empty snapshot defaults; the next append rebuilds from scratch.
    this.snapshotHydrated = true;
    const snapRow = this.sql.exec(
      "SELECT cursor, state_json FROM snapshots WHERE path = ?",
      "session",
    ).one() as { cursor: number; state_json: string } | undefined;
    if (snapRow) {
      try {
        const parsed = parseSessionSnapshot(JSON.parse(snapRow.state_json));
        if (parsed) {
          this.snapshot = parsed;
          this.snapshotCursor = snapRow.cursor;
          this.lastPersistedSnapshot = parsed;
          this.lastPersistedSnapshotCursor = snapRow.cursor;
        } else {
          this.getTracer()?.log("ERROR", "snapshot.hydrate.failed", {
            error: "SessionSnapshot validation failed",
          });
        }
      } catch (error) {
        this.getTracer()?.log("ERROR", "snapshot.hydrate.failed", {
          ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
        });
        // Leave defaults; next append will rebuild from scratch.
      }
    }
    // Events are the seven-day canonical history; hydrate the uncheckpointed
    // tail once, then maintain it in memory on the hot append path.
    this.eventsSincePersistedSnapshot = this.sql.exec(
      "SELECT COUNT(*) AS count FROM events WHERE id > ?",
      this.lastPersistedSnapshotCursor,
    ).one().count as number;
  }
}
