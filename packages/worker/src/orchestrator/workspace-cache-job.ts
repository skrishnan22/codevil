import { isTerminalState, safeExceptionAttributes } from "@codevil/shared";
import type { Sandbox } from "@cloudflare/sandbox";

import { redactEvent } from "../redaction.js";
import {
  createWorkspaceCacheSnapshotForSandbox,
  isRetryableWorkspaceCacheError,
  WORKSPACE_CACHE_TTL_SECONDS,
  WORKSPACE_CACHE_VERSION,
  type WorkspaceCacheCreateResult,
} from "../workspace-cache.js";
import type { OrchestratorHost } from "./host.js";

export const WORKSPACE_CACHE_JOB_ID = "workspace";
const MAX_WORKSPACE_CACHE_ATTEMPTS = 3;
const WORKSPACE_CACHE_RETRY_BASE_MS = 30_000;

export type WorkspaceCacheJobStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "exhausted"
  | "interrupted";

export interface WorkspaceCacheJobRow {
  job_id: string;
  repo: string;
  cache_version: string;
  source_session_id: string;
  status: WorkspaceCacheJobStatus;
  attempts: number;
  next_attempt_at: number | null;
  started_at: number | null;
  snapshot_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

type CacheJobResult = "ready" | "failed" | "exhausted" | "interrupted" | "deferred" | "missing";
export type CreateSnapshot = (input: {
  db: D1Database;
  binding: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  repo: string;
}) => Promise<WorkspaceCacheCreateResult>;

export function enqueueWorkspaceCacheJob(host: OrchestratorHost, now = Date.now()): void {
  if (!host.meta) return;
  const createdAt = new Date(now).toISOString();
  host.sql.exec(
    `INSERT INTO workspace_cache_jobs (
      job_id, repo, cache_version, source_session_id, status, attempts,
      next_attempt_at, started_at, snapshot_id, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`,
    WORKSPACE_CACHE_JOB_ID,
    host.meta.repo,
    WORKSPACE_CACHE_VERSION,
    host.meta.session_id,
    now,
    createdAt,
    createdAt,
  );
  // armNextAlarm intentionally ignores deadlines already in the past. Give
  // this newly-created due-now job a one-millisecond margin so the existing
  // alarm scheduler actually installs it.
  void host.armNextAlarm(now - 1).catch((error) => {
    host.getTracer()?.log("ERROR", "alarm.arm.failed", {
      ...redactEvent(safeExceptionAttributes(error), host.redactionSecrets),
      reason: "workspace_cache_job_enqueue",
    });
  });
}

export function getWorkspaceCacheJob(sql: SqlStorage): WorkspaceCacheJobRow | null {
  return (sql.exec(
    "SELECT * FROM workspace_cache_jobs WHERE job_id = ? LIMIT 1",
    WORKSPACE_CACHE_JOB_ID,
  ).toArray()[0] as unknown as WorkspaceCacheJobRow | undefined) ?? null;
}

export function workspaceCacheJobIsRunning(sql: SqlStorage): boolean {
  return getWorkspaceCacheJob(sql)?.status === "running";
}

export function nextWorkspaceCacheJobAt(sql: SqlStorage): number | null {
  const rows = sql.exec(
    "SELECT status, next_attempt_at, started_at FROM workspace_cache_jobs WHERE status = 'pending'",
  ).toArray() as unknown as Array<{
    status: WorkspaceCacheJobStatus;
    next_attempt_at: number | null;
    started_at: number | null;
  }>;
  const deadlines = rows.flatMap((row) => row.next_attempt_at === null ? [] : [row.next_attempt_at]);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function recoverWorkspaceCacheJobAfterRestart(host: OrchestratorHost, now = Date.now()): boolean {
  const job = getWorkspaceCacheJob(host.sql);
  if (!job) return false;

  if (job.status === "running") {
    requeueWorkspaceCacheJob(
      host.sql,
      now,
      "cache snapshot interrupted by Durable Object restart",
    );
  }
  void host.ctx.storage.setAlarm(now).catch((error) => {
    host.getTracer()?.log("ERROR", "alarm.arm.failed", {
      ...redactEvent(safeExceptionAttributes(error), host.redactionSecrets),
      reason: "workspace_cache_job_interrupted",
    });
  });
  return true;
}

export async function processWorkspaceCacheJob(
  host: OrchestratorHost,
  now = Date.now(),
  createSnapshot: CreateSnapshot = createWorkspaceCacheSnapshotForSandbox,
): Promise<CacheJobResult> {
  const job = getWorkspaceCacheJob(host.sql);
  if (!job) return "missing";
  if (job.status === "ready") return "ready";
  if (job.status === "failed") return "failed";
  if (job.status === "exhausted") return "exhausted";
  if (job.status === "interrupted") return "interrupted";
  if (job.status === "running") return "deferred";
  if (job.next_attempt_at !== null && job.next_attempt_at > now) return "deferred";

  if (!isWorkspaceQuiescent(host)) {
    interruptWorkspaceCacheJob(
      host.sql,
      now,
      "cache snapshot skipped because session state does not allow claiming",
    );
    return "interrupted";
  }
  const attempt = claimWorkspaceCacheJob(host.sql, now);
  if (!attempt) return "deferred";
  const startedAt = Date.now();
  host.getTracer()?.log("INFO", "workspace_cache.create.started", {
    repo: job.repo,
    cache_version: job.cache_version,
    backup_dir: "/workspace",
    ttl_seconds: WORKSPACE_CACHE_TTL_SECONDS,
    attempt,
  });

  let result: WorkspaceCacheCreateResult;
  try {
    result = await createSnapshot({
      db: host.workerEnv.DB,
      binding: host.workerEnv.Sandbox,
      sessionId: job.source_session_id,
      repo: job.repo,
    });
  } catch (error) {
    result = {
      created: false,
      phase: "backup",
      reason: failureReason(error, host.redactionSecrets),
      retryable: isRetryableWorkspaceCacheError(error),
    };
  }

  const durationMs = Date.now() - startedAt;
  if (result.created && result.snapshotId) {
    host.sql.exec(
      `UPDATE workspace_cache_jobs
       SET status = 'ready', snapshot_id = ?, next_attempt_at = NULL,
           started_at = NULL, last_error = NULL, updated_at = ?
       WHERE job_id = ?`,
      result.snapshotId,
      new Date().toISOString(),
      WORKSPACE_CACHE_JOB_ID,
    );
    host.getTracer()?.log("INFO", "workspace_cache.create.ready", {
      snapshot_id: result.snapshotId,
      repo: job.repo,
      duration_ms: durationMs,
      attempt,
    });
    return "ready";
  }

  const reason = failureReason(result.reason ?? "cache snapshot was not created", host.redactionSecrets);
  if (result.retryable && attempt < MAX_WORKSPACE_CACHE_ATTEMPTS) {
    const nextAttemptAt = now + retryDelayMs(attempt);
    host.sql.exec(
      `UPDATE workspace_cache_jobs
       SET status = 'pending', next_attempt_at = ?, started_at = NULL,
           last_error = ?, updated_at = ?
       WHERE job_id = ?`,
      nextAttemptAt,
      reason,
      new Date().toISOString(),
      WORKSPACE_CACHE_JOB_ID,
    );
    void host.armNextAlarm(nextAttemptAt - 1).catch((error) => {
      host.getTracer()?.log("ERROR", "alarm.arm.failed", {
        ...redactEvent(safeExceptionAttributes(error), host.redactionSecrets),
        reason: "workspace_cache_job_retry",
      });
    });
    host.getTracer()?.log("WARN", "workspace_cache.create.retrying", {
      phase: result.phase ?? "unknown",
      reason,
      repo: job.repo,
      duration_ms: durationMs,
      attempt,
      next_attempt_at: nextAttemptAt,
    });
    return "deferred";
  }

  const terminalStatus = result.retryable ? "exhausted" : "failed";
  host.sql.exec(
    `UPDATE workspace_cache_jobs
     SET status = ?, next_attempt_at = NULL, started_at = NULL,
         last_error = ?, updated_at = ?
     WHERE job_id = ?`,
    terminalStatus,
    reason,
    new Date().toISOString(),
    WORKSPACE_CACHE_JOB_ID,
  );
  host.getTracer()?.log("ERROR", "workspace_cache.create.failed", {
    phase: result.phase ?? "unknown",
    reason,
    repo: job.repo,
    duration_ms: durationMs,
    attempt,
    status: terminalStatus,
  });
  return terminalStatus;
}

/** A snapshot may be taken while an agent run is active: the cache is derived
 *  data and restored state is validated (dependency fingerprint + artifact
 *  presence), so a torn snapshot degrades to a reinstall, never a broken
 *  session. Only sessions that can still use the workspace may claim. */
function isWorkspaceQuiescent(host: OrchestratorHost): boolean {
  const meta = host.meta;
  return Boolean(
    meta
    && (meta.state === "ready" || isTerminalState(meta.state)),
  );
}

function claimWorkspaceCacheJob(sql: SqlStorage, now: number): number | null {
  const job = getWorkspaceCacheJob(sql);
  if (!job || job.status === "ready") return null;
  const attempts = job.attempts + 1;
  sql.exec(
    `UPDATE workspace_cache_jobs
     SET status = 'running', attempts = ?, started_at = ?,
         next_attempt_at = NULL, updated_at = ?
     WHERE job_id = ? AND status = 'pending'`,
    attempts,
    now,
    new Date(now).toISOString(),
    WORKSPACE_CACHE_JOB_ID,
  );
  return attempts;
}

function interruptWorkspaceCacheJob(sql: SqlStorage, now: number, reason: string): void {
  sql.exec(
    `UPDATE workspace_cache_jobs
     SET status = 'interrupted', next_attempt_at = NULL, started_at = NULL,
         last_error = ?, updated_at = ?
     WHERE job_id = ? AND status IN ('pending', 'running')`,
    reason,
    new Date(now).toISOString(),
    WORKSPACE_CACHE_JOB_ID,
  );
}

function requeueWorkspaceCacheJob(sql: SqlStorage, now: number, reason: string): void {
  sql.exec(
    `UPDATE workspace_cache_jobs
     SET status = 'pending', next_attempt_at = ?, started_at = NULL,
         last_error = ?, updated_at = ?
     WHERE job_id = ? AND status = 'running'`,
    now,
    reason,
    new Date(now).toISOString(),
    WORKSPACE_CACHE_JOB_ID,
  );
}

function retryDelayMs(attempt: number): number {
  return WORKSPACE_CACHE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

function failureReason(error: unknown, secrets: readonly string[]): string {
  const attributes = redactEvent(
    typeof error === "string" ? { error } : safeExceptionAttributes(error),
    secrets,
  );
  const reason = typeof attributes.error === "string"
    ? attributes.error
    : typeof attributes.message === "string"
      ? attributes.message
      : "cache snapshot failed";
  return reason.slice(0, 1_000);
}
