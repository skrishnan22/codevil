import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CACHE_JOB_QUIET_RETRY_MS,
  CACHE_JOB_STALE_MS,
  enqueueWorkspaceCacheJob,
  getWorkspaceCacheJob,
  nextWorkspaceCacheJobAt,
  processWorkspaceCacheJob,
  recoverStaleWorkspaceCacheJob,
  workspaceCacheJobIsRunning,
} from "../dist/orchestrator/workspace-cache-job.js";

function createSql() {
  const rows = new Map();
  return {
    rows,
    exec(query, ...params) {
      if (query.includes("INSERT INTO workspace_cache_jobs")) {
        if (!rows.has(params[0])) {
          rows.set(params[0], {
            job_id: params[0],
            repo: params[1],
            cache_version: params[2],
            source_session_id: params[3],
            status: "pending",
            attempts: 0,
            next_attempt_at: params[4],
            started_at: null,
            snapshot_id: null,
            last_error: null,
            created_at: params[5],
            updated_at: params[6],
          });
        }
        return [];
      }
      if (query.includes("SELECT * FROM workspace_cache_jobs")) {
        const row = rows.get(params[0]);
        return { toArray: () => (row ? [row] : []), one: () => row };
      }
      if (query.includes("SELECT status, next_attempt_at, started_at")) {
        return { toArray: () => [...rows.values()] };
      }
      if (query.includes("SET status = 'running'")) {
        const [attempts, now, nowAgain] = params;
        const row = rows.get("workspace");
        if (row) {
          row.status = "running";
          row.attempts = attempts;
          row.started_at = now;
          row.next_attempt_at = null;
          row.updated_at = nowAgain;
        }
        return [];
      }
      if (query.includes("SET status = 'pending'")) {
        const [next, errorOrNow, nowMaybe] = params;
        const row = rows.get("workspace");
        if (row) {
          row.status = "pending";
          row.next_attempt_at = next;
          row.started_at = null;
          row.last_error = nowMaybe ? errorOrNow : row.last_error;
          row.updated_at = nowMaybe ?? errorOrNow;
        }
        return [];
      }
      if (query.includes("SET status = 'ready'")) {
        const [snapshotId, now] = params;
        const row = rows.get("workspace");
        row.status = "ready";
        row.snapshot_id = snapshotId;
        row.started_at = null;
        row.next_attempt_at = null;
        row.updated_at = now;
        return [];
      }
      if (query.includes("SET status = 'failed'")) {
        const [next, error, now] = params;
        const row = rows.get("workspace");
        row.status = "failed";
        row.next_attempt_at = next;
        row.last_error = error;
        row.started_at = null;
        row.updated_at = now;
        return [];
      }
      throw new Error(`Unhandled SQL: ${query}`);
    },
  };
}

function createHost(sql, overrides = {}) {
  const logs = [];
  const alarms = [];
  return {
    sql,
    meta: {
      session_id: "ses_test",
      repo: "https://github.com/acme/app",
      state: "ready",
      active_run: null,
      ...overrides.meta,
    },
    workerEnv: { DB: {}, Sandbox: {} },
    redactionSecrets: [],
    ctx: { storage: { setAlarm: async (when) => alarms.push(when) } },
    getTracer: () => ({ log: (...args) => logs.push(args) }),
    armNextAlarm: async () => {},
    logs,
    alarms,
  };
}

test("enqueue creates one durable cache job and exposes its alarm deadline", () => {
  const sql = createSql();
  enqueueWorkspaceCacheJob(createHost(sql), 1_000);

  assert.equal(getWorkspaceCacheJob(sql).status, "pending");
  assert.equal(nextWorkspaceCacheJobAt(sql), 1_000);

  enqueueWorkspaceCacheJob(createHost(sql), 2_000);
  assert.equal(sql.rows.size, 1);
});

test("active runs defer the job without starting a backup", async () => {
  const sql = createSql();
  const host = createHost(sql, { meta: { active_run: { id: "run_1" } } });
  enqueueWorkspaceCacheJob(host, 1_000);
  let calls = 0;

  const result = await processWorkspaceCacheJob(host, 1_000, async () => {
    calls += 1;
    return { created: true, snapshotId: "unexpected" };
  });

  assert.equal(result, "deferred");
  assert.equal(calls, 0);
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, 1_000 + CACHE_JOB_QUIET_RETRY_MS);
});

test("successful alarm processing persists the snapshot id", async () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);

  const result = await processWorkspaceCacheJob(host, 1_000, async () => ({
    created: true,
    snapshotId: "wsc_123",
  }));

  assert.equal(result, "ready");
  assert.equal(getWorkspaceCacheJob(sql).status, "ready");
  assert.equal(getWorkspaceCacheJob(sql).snapshot_id, "wsc_123");
});

test("running cache work is durably visible while the backup RPC is awaiting", async () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);
  let release;
  const backupPending = new Promise((resolve) => { release = resolve; });

  const processing = processWorkspaceCacheJob(host, 1_000, async () => {
    assert.equal(workspaceCacheJobIsRunning(sql), true);
    await backupPending;
    return { created: true, snapshotId: "wsc_interleaved" };
  });

  assert.equal(workspaceCacheJobIsRunning(sql), true);
  release();
  await processing;
  assert.equal(workspaceCacheJobIsRunning(sql), false);
});

test("failed processing records a retry deadline and a later alarm can recover", async () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);
  let calls = 0;

  const first = await processWorkspaceCacheJob(host, 1_000, async () => {
    calls += 1;
    return { created: false, phase: "backup", reason: "backup canceled" };
  });
  assert.equal(first, "failed");
  assert.equal(getWorkspaceCacheJob(sql).status, "failed");
  assert.ok(getWorkspaceCacheJob(sql).next_attempt_at > 1_000);

  const second = await processWorkspaceCacheJob(host, getWorkspaceCacheJob(sql).next_attempt_at, async () => {
    calls += 1;
    return { created: true, snapshotId: "wsc_recovered" };
  });
  assert.equal(second, "ready");
  assert.equal(calls, 2);
});

test("a running job past the stale threshold is recovered after a DO restart", () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);
  sql.rows.get("workspace").status = "running";
  sql.rows.get("workspace").started_at = 1_000;

  assert.equal(nextWorkspaceCacheJobAt(sql), 1_000 + CACHE_JOB_STALE_MS);
  assert.equal(recoverStaleWorkspaceCacheJob(sql, 1_000 + CACHE_JOB_STALE_MS - 1), false);
  assert.equal(recoverStaleWorkspaceCacheJob(sql, 1_000 + CACHE_JOB_STALE_MS), true);
  assert.equal(getWorkspaceCacheJob(sql).status, "pending");
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, 1_000 + CACHE_JOB_STALE_MS);
});
