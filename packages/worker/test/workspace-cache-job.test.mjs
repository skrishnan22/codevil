import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enqueueWorkspaceCacheJob,
  getWorkspaceCacheJob,
  nextWorkspaceCacheJobAt,
  processWorkspaceCacheJob,
  recoverWorkspaceCacheJobAfterRestart,
  workspaceCacheJobBlocksAgentWork,
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
      if (query.includes("SET status = 'interrupted'")) {
        const [error, now] = params;
        const row = rows.get("workspace");
        if (row) {
          row.status = "interrupted";
          row.next_attempt_at = null;
          row.started_at = null;
          row.last_error = error;
          row.updated_at = now;
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
      if (query.includes("SET status = ?, next_attempt_at = ?")) {
        const [status, next, error, now] = params;
        const row = rows.get("workspace");
        row.status = status;
        row.next_attempt_at = next;
        row.last_error = error;
        row.started_at = null;
        row.updated_at = now;
        return [];
      }
      if (query.includes("SET status = 'failed'")) {
        const [error, now] = params;
        const row = rows.get("workspace");
        row.status = "failed";
        row.next_attempt_at = null;
        row.last_error = error;
        row.started_at = null;
        row.updated_at = now;
        return [];
      }
      if (query.includes("SET status = ?")) {
        const [status, lastError, updatedAt] = params;
        const row = rows.get("workspace");
        row.status = status;
        row.last_error = lastError;
        row.started_at = null;
        row.next_attempt_at = null;
        row.updated_at = updatedAt;
        return [];
      }
      if (query.includes("SET status = 'exhausted'")) {
        const [error, now] = params;
        const row = rows.get("workspace");
        row.status = "exhausted";
        row.next_attempt_at = null;
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

test("only pending and running jobs block agent work", () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);

  assert.equal(workspaceCacheJobBlocksAgentWork(sql), true);

  sql.rows.get("workspace").status = "running";
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), true);

  sql.rows.get("workspace").status = "failed";
  sql.rows.get("workspace").next_attempt_at = null;
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), false);

  sql.rows.get("workspace").status = "exhausted";
  sql.rows.get("workspace").next_attempt_at = null;
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), false);

  sql.rows.get("workspace").status = "interrupted";
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), false);

  sql.rows.get("workspace").status = "ready";
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), false);
});

test("unexpected active work interrupts the cache job without retrying", async () => {
  const sql = createSql();
  const host = createHost(sql, { meta: { active_run: { id: "run_1" } } });
  enqueueWorkspaceCacheJob(host, 1_000);
  let calls = 0;

  const result = await processWorkspaceCacheJob(host, 1_000, async () => {
    calls += 1;
    return { created: true, snapshotId: "unexpected" };
  });

  assert.equal(result, "interrupted");
  assert.equal(calls, 0);
  assert.equal(getWorkspaceCacheJob(sql).status, "interrupted");
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, null);
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), false);
});

test("successful clone-event processing persists the snapshot id", async () => {
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

test("failed processing is terminal and never retries after agent work can start", async () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);
  let calls = 0;

  const result = await processWorkspaceCacheJob(host, 1_000, async () => {
    calls += 1;
    return { created: false, phase: "backup", reason: "backup canceled" };
  });
  assert.equal(result, "failed");
  assert.equal(getWorkspaceCacheJob(sql).status, "failed");
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, null);
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), false);

  const later = await processWorkspaceCacheJob(host, 60_000, async () => {
    calls += 1;
    return { created: true, snapshotId: "must-not-run" };
  });
  assert.equal(later, "failed");
  assert.equal(calls, 1);
});

test("retryable Durable Object resets are requeued with backoff", async () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);

  const first = await processWorkspaceCacheJob(host, 1_000, async () => ({
    created: false,
    phase: "backup",
    reason: "Durable Object reset because its code was updated",
    retryable: true,
  }));

  assert.equal(first, "deferred");
  assert.equal(getWorkspaceCacheJob(sql).status, "pending");
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, 31_000);
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), true);

  const second = await processWorkspaceCacheJob(host, 31_000, async () => ({
    created: true,
    snapshotId: "wsc_after_reset",
  }));
  assert.equal(second, "ready");
  assert.equal(getWorkspaceCacheJob(sql).status, "ready");
});

test("a persisted running job is requeued after a DO restart", () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);
  sql.rows.get("workspace").status = "running";
  sql.rows.get("workspace").started_at = 1_000;

  assert.equal(recoverWorkspaceCacheJobAfterRestart(host, 1_001), true);
  assert.equal(getWorkspaceCacheJob(sql).status, "pending");
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, 1_001);
  assert.equal(nextWorkspaceCacheJobAt(sql), 1_001);
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), true);
  assert.deepEqual(host.alarms, [1_001]);
});

test("a persisted pending job remains retryable after a DO restart", () => {
  const sql = createSql();
  const host = createHost(sql);
  enqueueWorkspaceCacheJob(host, 1_000);

  assert.equal(recoverWorkspaceCacheJobAfterRestart(host, 1_001), true);
  assert.equal(getWorkspaceCacheJob(sql).status, "pending");
  assert.equal(getWorkspaceCacheJob(sql).next_attempt_at, 1_000);
  assert.equal(nextWorkspaceCacheJobAt(sql), 1_000);
  assert.equal(workspaceCacheJobBlocksAgentWork(sql), true);
  assert.deepEqual(host.alarms, [1_001]);
});

test("terminal cache jobs arm queued-work processing after a DO restart", () => {
  for (const status of ["ready", "failed", "exhausted", "interrupted"]) {
    const sql = createSql();
    const host = createHost(sql);
    enqueueWorkspaceCacheJob(host, 1_000);
    sql.rows.get("workspace").status = status;
    sql.rows.get("workspace").next_attempt_at = null;
    host.alarms.length = 0;

    assert.equal(recoverWorkspaceCacheJobAfterRestart(host, 2_000), true, status);
    assert.equal(getWorkspaceCacheJob(sql).status, status);
    assert.deepEqual(host.alarms, [2_000]);
  }
});
