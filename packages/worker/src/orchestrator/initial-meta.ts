import { DEFAULT_CONFIG, type SessionMeta } from "@codevil/shared";

import { DEFAULT_MAX_IDLE_TIME } from "../session-directory.js";
import type { InitOptions } from "./types.js";

/** The Session meta a freshly created Orchestrator persists in `init`. */
export function buildInitialSessionMeta(
  sessionId: string,
  prompt: string,
  repo: string,
  options: InitOptions,
  now: Date,
): SessionMeta {
  const createdAt = now.toISOString();
  return {
    session_id: sessionId,
    prompt,
    repo,
    worker_url: options.worker_url,
    provider: options.provider ?? DEFAULT_CONFIG.provider,
    plan_model: options.plan_model ?? DEFAULT_CONFIG.plan_model,
    exec_model: options.exec_model ?? DEFAULT_CONFIG.exec_model,
    max_time: options.max_time ?? DEFAULT_CONFIG.max_time,
    state: "initializing",
    refinement_round: 0,
    verification_attempts: 0,
    cost_total_usd: 0,
    active_run: null,
    queued_runs: [],
    created_by: options.created_by,
    sandbox_provider: options.sandbox_provider ?? "cloudflare",
    max_idle_time: options.max_idle_time ?? DEFAULT_MAX_IDLE_TIME,
    last_activity_at: createdAt,
    created_at: createdAt,
  };
}
