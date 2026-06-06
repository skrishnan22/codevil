import {
  CreateSessionRequestSchema,
  DEFAULT_CONFIG,
  type AgentRunState,
  type CreateSessionRequest,
  type ParticipantIdentity,
  type RoomState,
  type SandboxState,
  type SessionSummary,
} from "@codevil/shared";

export interface NormalizedCreateSession extends Required<Omit<CreateSessionRequest,
  "created_by" | "provider" | "plan_model" | "exec_model" | "max_cost" | "max_session_time" | "max_idle_time" | "max_steps"
>> {
  title: string;
  provider: string;
  plan_model: string;
  exec_model: string;
  max_cost: string;
  max_session_time: string;
  max_idle_time: string;
  max_steps: number;
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
    max_cost: parsed.max_cost ?? DEFAULT_CONFIG.max_cost,
    max_session_time: parsed.max_session_time ?? DEFAULT_CONFIG.max_time,
    max_idle_time: parsed.max_idle_time ?? DEFAULT_MAX_IDLE_TIME,
    max_steps: parsed.max_steps ?? DEFAULT_CONFIG.max_steps,
    ...(parsed.created_by ? { created_by: parsed.created_by } : {}),
  };
}

export function deriveSessionTitle(repo: string): string {
  const trimmed = repo.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = trimmed.match(/(?:^|\/\/|@)github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/\s]+)$/);
  if (match?.groups) return `${match.groups.owner}/${match.groups.repo}`;
  return trimmed || "Untitled room";
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
      created_at,
      updated_at,
      last_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.created_at,
      row.updated_at,
      row.last_event_at,
    ],
  };
}

export function sessionDirectoryFailureUpdate(sessionId: string, now: string): SqlStatement {
  return {
    sql: "UPDATE sessions SET room_state = ?, sandbox_state = ?, updated_at = ?, last_event_at = ? WHERE id = ?",
    bindings: ["failed", "failed", now, now, sessionId],
  };
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
