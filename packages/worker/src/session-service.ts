import { workerLogSessionExceptionForEnv } from "./logging.js";
import {
  buildSessionSummary,
  legacyDirectoryGuardColumns,
  normalizeCreateSessionBody,
  sessionDirectoryFailureUpdate,
  sessionDirectoryInsert,
  type NormalizedCreateSession,
  type SessionDirectoryRow,
} from "./session-directory.js";
import type { Env } from "./worker-env.js";

export interface SessionCreator {
  id: string;
  name: string;
  email?: string | null;
}

export interface CreateSessionResult {
  session_id: string;
  ws_url: string;
  summary: ReturnType<typeof buildSessionSummary>;
}

type CreateSessionInput = NormalizedCreateSession | { repo: string };

export async function createSession(
  env: Env,
  requestUrlOrOrigin: string,
  input: CreateSessionInput,
  createdBy: SessionCreator,
): Promise<CreateSessionResult> {
  const normalized = isNormalizedCreateSession(input)
    ? input
    : normalizeCreateSessionBody(input);
  const sessionId = `ses_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();
  const origin = new URL(requestUrlOrOrigin).origin;
  const legacyGuards = legacyDirectoryGuardColumns();
  const row: SessionDirectoryRow = {
    id: sessionId,
    repo: normalized.repo,
    title: normalized.title,
    provider: normalized.provider,
    plan_model: normalized.plan_model,
    exec_model: normalized.exec_model,
    max_cost: legacyGuards.max_cost,
    max_session_time: normalized.max_session_time,
    max_idle_time: normalized.max_idle_time,
    max_steps: legacyGuards.max_steps,
    room_state: "initializing",
    sandbox_state: "not_started",
    created_by_id: createdBy.id,
    created_by_name: createdBy.name,
    created_by_email: createdBy.email ?? null,
    created_at: now,
    updated_at: now,
    last_event_at: now,
  };

  const insert = sessionDirectoryInsert(row);
  await env.DB.prepare(insert.sql).bind(...insert.bindings).run();

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);

  try {
    await stub.init(sessionId, normalized.title, normalized.repo, {
      worker_url: origin,
      provider: normalized.provider,
      plan_model: normalized.plan_model,
      exec_model: normalized.exec_model,
      max_time: normalized.max_session_time,
      created_by: { id: createdBy.id, name: createdBy.name },
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failure = sessionDirectoryFailureUpdate(sessionId, failedAt);
    await env.DB.prepare(failure.sql).bind(...failure.bindings).run();
    workerLogSessionExceptionForEnv(sessionId, "session.init.failed", error, env);
    throw error;
  }

  return {
    session_id: sessionId,
    ws_url: new URL(`/sessions/${sessionId}/ws`, origin).toString(),
    summary: buildSessionSummary(row),
  };
}

function isNormalizedCreateSession(input: CreateSessionInput): input is NormalizedCreateSession {
  return "title" in input
    && "provider" in input
    && "plan_model" in input
    && "exec_model" in input
    && "max_session_time" in input
    && "max_idle_time" in input;
}
