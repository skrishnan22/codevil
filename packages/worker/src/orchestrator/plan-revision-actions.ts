import type { OrchestratorHost } from "./host.js";
import {
  loadOpenAnnotationThreads,
  loadPlanRevision,
} from "./plan-revisions-store.js";

export function freezePlanRevision(
  host: OrchestratorHost,
  runId: string,
  round: number,
  markdown: string,
): void {
  const now = new Date().toISOString();
  if (round > 0) {
    consumeOpenAnnotations(host, runId, round - 1);
  }
  host.sql.exec(
    `INSERT OR REPLACE INTO plan_revisions (
      run_id, round, markdown, locked_at, frozen_at
    ) VALUES (?, ?, ?, NULL, ?)`,
    runId,
    round,
    markdown,
    now,
  );
  host.appendAndBroadcast({
    type: "plan_revision_frozen",
    run_id: runId,
    round,
    markdown,
    locked: false,
    created_at: now,
  });
}

export function lockPlanRevision(host: OrchestratorHost, runId: string, round: number): void {
  const lockedAt = new Date().toISOString();
  host.sql.exec(
    `UPDATE plan_revisions
     SET locked_at = COALESCE(locked_at, ?)
     WHERE run_id = ? AND round = ?`,
    lockedAt,
    runId,
    round,
  );
  host.appendAndBroadcast({
    type: "plan_revision_frozen",
    run_id: runId,
    round,
    locked: true,
    created_at: lockedAt,
  });
}

export function consumeOpenAnnotations(host: OrchestratorHost, runId: string, round: number): void {
  const ids = loadOpenAnnotationThreads(host.sql, runId, round).map((thread) => thread.id);
  if (ids.length === 0) return;

  host.sql.exec(
    "UPDATE annotations SET status = 'consumed' WHERE revision_run_id = ? AND revision_round = ? AND status = 'open'",
    runId,
    round,
  );
  host.appendAndBroadcast({
    type: "annotations_consumed",
    run_id: runId,
    round,
    thread_ids: ids,
  });
}

export function ensureAnnotatableRevision(host: OrchestratorHost, runId: string, round: number): boolean {
  if (!host.meta) return false;
  if (!host.meta.active_run?.plan_first) {
    host.appendAndBroadcast({ type: "error", message: "Annotations are only available on plan-first runs." });
    return false;
  }
  if (host.meta.state !== "awaiting_approval") {
    host.appendAndBroadcast({ type: "error", message: `Cannot annotate in state: ${host.meta.state}` });
    return false;
  }
  if (host.meta.active_run.id !== runId || host.meta.refinement_round !== round) {
    host.appendAndBroadcast({ type: "error", message: "Annotation target is not the active plan revision." });
    return false;
  }

  const revision = loadPlanRevision(host.sql, runId, round);
  if (!revision) {
    host.appendAndBroadcast({ type: "error", message: "Plan revision not found." });
    return false;
  }
  if (revision.locked_at) {
    host.appendAndBroadcast({ type: "error", message: "Plan revision is locked." });
    return false;
  }

  return true;
}
