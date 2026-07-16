import type { SessionMeta } from "@codevil/shared";

/** Session domain context for wide events — high-cardinality fields for debugging. */
export function sessionWideEventGroup(meta: SessionMeta): Record<string, unknown> {
  return {
    session_id: meta.session_id,
    repo: meta.repo,
    state: meta.state,
    provider: meta.provider,
    plan_model: meta.plan_model,
    exec_model: meta.exec_model,
    cost_total_usd: meta.cost_total_usd,
    refinement_round: meta.refinement_round,
    verification_attempts: meta.verification_attempts,
    workspace_cache_restored: meta.workspace_cache_restored ?? false,
    active_run_id: meta.active_run?.id ?? null,
    active_run_state: meta.active_run?.state ?? null,
    queued_run_count: meta.queued_runs?.length ?? 0,
    created_at: meta.created_at,
  };
}
