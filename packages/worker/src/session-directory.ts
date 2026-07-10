import {
  CreateSessionRequestSchema,
  DEFAULT_CONFIG,
  type AgentRunState,
  type ParticipantIdentity,
  type RoomState,
  type SandboxState,
  type SessionSummary,
} from "@codevil/shared";

/** Legacy D1 guard columns retained for schema compatibility; cost enforcement removed in v1. */
const LEGACY_DIRECTORY_MAX_COST = "";
const LEGACY_DIRECTORY_MAX_STEPS = 0;

export interface NormalizedCreateSession {
  repo: string;
  title: string;
  provider: string;
  plan_model: string;
  exec_model: string;
  max_session_time: string;
  max_idle_time: string;
  created_by?: ParticipantIdentity;
}

export interface SessionDirectoryRow {
  id: string;
  repo: string;
  title: string;
  provider: string;
  plan_model: string;
  exec_model: string;
  max_cost: string;
  max_session_time: string;
  max_idle_time: string;
  max_steps: number;
  room_state: RoomState;
  sandbox_state: SandboxState;
  active_run_state?: AgentRunState | null;
  created_by_id?: string | null;
  created_by_name?: string | null;
  created_by_email?: string | null;
  created_at: string;
  updated_at: string;
  last_event_at: string;
}

export interface SqlStatement {
  sql: string;
  bindings: unknown[];
}

const DEFAULT_MAX_IDLE_TIME = "10m";

export function normalizeCreateSessionBody(body: unknown): NormalizedCreateSession {
  const parsed = CreateSessionRequestSchema.parse(body);
  return {
    repo: parsed.repo,
    title: deriveSessionTitle(parsed.repo),
    provider: parsed.provider ?? DEFAULT_CONFIG.provider,
    plan_model: parsed.plan_model ?? DEFAULT_CONFIG.plan_model,
    exec_model: parsed.exec_model ?? DEFAULT_CONFIG.exec_model,
    max_session_time: parsed.max_session_time ?? DEFAULT_CONFIG.max_time,
    max_idle_time: parsed.max_idle_time ?? DEFAULT_MAX_IDLE_TIME,
    ...(parsed.created_by ? { created_by: parsed.created_by } : {}),
  };
}

export function deriveSessionTitle(repo: string): string {
  const trimmed = repo.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = trimmed.match(/(?:^|\/\/|@)github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/\s]+)$/);
  if (match?.groups) return `${match.groups.owner}/${match.groups.repo}`;
  return trimmed || "Untitled session";
}

export function buildSessionSummary(row: SessionDirectoryRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    repo: row.repo,
    room_state: row.room_state,
    sandbox_state: row.sandbox_state,
    ...(row.active_run_state ? { active_run_state: row.active_run_state } : {}),
    ...(row.created_by_id && row.created_by_name
      ? { created_by: { id: row.created_by_id, name: row.created_by_name } }
      : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_event_at: row.last_event_at,
  };
}

export function sessionDirectoryInsert(row: SessionDirectoryRow): SqlStatement {
  return {
    sql: `INSERT INTO sessions (
      id,
      repo,
      title,
      provider,
      plan_model,
      exec_model,
      max_cost,
      max_session_time,
      max_idle_time,
      max_steps,
      room_state,
      sandbox_state,
      active_run_state,
      created_by_id,
      created_by_name,
      created_by_email,
      created_at,
      updated_at,
      last_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      row.id,
      row.repo,
      row.title,
      row.provider,
      row.plan_model,
      row.exec_model,
      row.max_cost,
      row.max_session_time,
      row.max_idle_time,
      row.max_steps,
      row.room_state,
      row.sandbox_state,
      row.active_run_state ?? null,
      row.created_by_id ?? null,
      row.created_by_name ?? null,
      row.created_by_email ?? null,
      row.created_at,
      row.updated_at,
      row.last_event_at,
    ],
  };
}

export function legacyDirectoryGuardColumns(): { max_cost: string; max_steps: number } {
  // Written on session create for D1 schema compatibility only; not read for enforcement.
  return {
    max_cost: LEGACY_DIRECTORY_MAX_COST,
    max_steps: LEGACY_DIRECTORY_MAX_STEPS,
  };
}

/** HTTP header carrying a client-generated idempotency token for POST /sessions. */
export const SESSION_IDEMPOTENCY_HEADER = "Idempotency-Key";
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export interface SessionIdempotencyRow {
  user_id: string;
  idempotency_key: string;
  session_id: string;
  created_at: string;
}

export function normalizeIdempotencyKey(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error("Idempotency-Key must use only letters, numbers, and . _ : -");
  }
  return trimmed;
}

export function sessionIdempotencyLookup(
  userId: string,
  idempotencyKey: string,
): SqlStatement {
  return {
    sql: `SELECT session_id, created_at
      FROM session_idempotency
      WHERE user_id = ? AND idempotency_key = ?`,
    bindings: [userId, idempotencyKey],
  };
}

export function sessionIdempotencyInsert(
  row: SessionIdempotencyRow,
): SqlStatement {
  return {
    sql: `INSERT INTO session_idempotency (user_id, idempotency_key, session_id, created_at)
      VALUES (?, ?, ?, ?)`,
    bindings: [row.user_id, row.idempotency_key, row.session_id, row.created_at],
  };
}

export function buildCreateSessionResponse(
  sessionId: string,
  requestUrl: string,
  row: SessionDirectoryRow,
): { session_id: string; ws_url: string; summary: SessionSummary } {
  return {
    session_id: sessionId,
    ws_url: new URL(`/sessions/${sessionId}/ws`, requestUrl).toString(),
    summary: buildSessionSummary(row),
  };
}

export function sessionDirectoryFailureUpdate(sessionId: string, now: string): SqlStatement {
  return {
    sql: "UPDATE sessions SET room_state = ?, sandbox_state = ?, updated_at = ?, last_event_at = ? WHERE id = ?",
    bindings: ["failed", "failed", now, now, sessionId],
  };
}

/**
 * Returns a timestamp that is strictly newer than a persisted directory
 * baseline. Durable Objects can restart with an empty in-memory clock, and
 * wall clocks can be behind a value previously written by another attempt.
 */
export function nextSessionDirectoryTimestamp(candidate: string, persistedBaseline: string): string {
  if (candidate > persistedBaseline) return candidate;

  const parsedBaseline = Date.parse(persistedBaseline);
  if (!Number.isFinite(parsedBaseline)) return candidate;
  return new Date(parsedBaseline + 1).toISOString();
}

export async function runSessionDirectoryUpdateWithRetry(
  db: D1Database,
  sql: string,
  bindings: unknown[],
  options: {
    attempts?: number;
    backoffMs?: number;
    attemptTimeoutMs?: number;
    onFailure: (error: unknown) => void;
  },
): Promise<D1Result<unknown> | undefined> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 50;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 5_000;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await withAttemptTimeout(
        db.prepare(sql).bind(...bindings).run(),
        attemptTimeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      }
    }
  }

  options.onFailure(lastError);
  return undefined;
}

async function withAttemptTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Session directory update attempt timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function recentSessionsSelect(cutoffIso: string, limit: number): SqlStatement {
  return {
    sql: `SELECT * FROM sessions
      WHERE last_event_at >= ?
      ORDER BY last_event_at DESC
      LIMIT ?`,
    bindings: [cutoffIso, limit],
  };
}

export function sessionByIdSelect(sessionId: string): SqlStatement {
  return {
    sql: "SELECT * FROM sessions WHERE id = ?",
    bindings: [sessionId],
  };
}
