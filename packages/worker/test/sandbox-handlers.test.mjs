import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRun } from "../dist/agent-runs.js";
import {
  drainQueuedAgentWorkIfWorkspaceCacheSettled,
  dispatchSandboxSocketMessage,
  handleSandboxCloneComplete,
  handleSandboxCloneStarted,
  handleSandboxPlanReady,
  issueProxyCapabilities,
  provisionSessionSandbox,
} from "../dist/orchestrator/sandbox-handlers.js";
import { handleSandboxProxy } from "../dist/sandbox-proxy.js";
import { actor, createFakeHost, createFakeTracer } from "./helpers/fake-host.mjs";

function createCacheJobSql() {
  let row = null;
  return {
    get row() {
      return row;
    },
    exec(query, ...params) {
      if (query.includes("INSERT INTO workspace_cache_jobs")) {
        row ??= {
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
        };
        return [];
      }
      if (query.includes("SELECT * FROM workspace_cache_jobs")) {
        return { toArray: () => row ? [row] : [] };
      }
      if (query.includes("SET status = 'running'")) {
        const [attempts, now, updatedAt] = params;
        row.status = "running";
        row.attempts = attempts;
        row.started_at = now;
        row.next_attempt_at = null;
        row.updated_at = updatedAt;
        return [];
      }
      if (query.includes("SET status = 'ready'")) {
        const [snapshotId, updatedAt] = params;
        row.status = "ready";
        row.snapshot_id = snapshotId;
        row.started_at = null;
        row.next_attempt_at = null;
        row.updated_at = updatedAt;
        return [];
      }
      if (query.includes("SET status = 'failed'")) {
        const [lastError, updatedAt] = params;
        row.status = "failed";
        row.last_error = lastError;
        row.started_at = null;
        row.next_attempt_at = null;
        row.updated_at = updatedAt;
        return [];
      }
      throw new Error(`Unhandled SQL: ${query}`);
    },
  };
}

function createWsRecorder() {
  const sent = [];
  return {
    sent,
    ws: {
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    },
  };
}

test("dispatchSandboxSocketMessage replies with protocol_error on invalid JSON", async () => {
  const { ws, sent } = createWsRecorder();

  await dispatchSandboxSocketMessage({ loadMeta() {} }, ws, "not json");

  assert.deepEqual(sent[0], { type: "protocol_error", message: "Invalid JSON" });
});

test("dispatchSandboxSocketMessage replies with protocol_error on schema validation failure", async () => {
  const { ws, sent } = createWsRecorder();
  const host = { meta: { session_id: "ses_test" }, loadMeta() {} };

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "not_a_sandbox_message" }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "protocol_error");
  assert.match(sent[0].message, /Invalid message/);
});

test("dispatchSandboxSocketMessage routes valid clone_started to its handler", async () => {
  const { host, transitions, directoryPatches } = createFakeHost({ state: "provisioning_sandbox" });
  const { ws, sent } = createWsRecorder();

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "clone_started" }));

  assert.equal(sent.length, 0);
  assert.equal(host.meta.state, "cloning_repo");
  assert.deepEqual(transitions.at(-1), { from: "provisioning_sandbox", to: "cloning_repo" });
  assert.deepEqual(directoryPatches.at(-1), { sandbox_state: "cloning" });
});

test("authenticated sandbox capability refresh returns new session-bound short-lived tokens", async () => {
  const { host } = createFakeHost({}, {
    workerEnv: { CODEVIL_PROXY_SIGNING_SECRET: "test-signing-secret", CODEVIL_API_KEY: "test-key", Sandbox: {}, DB: {} },
  });
  const { ws, sent } = createWsRecorder();

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "proxy_capabilities_refresh_request" }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "proxy_capabilities");
  assert.match(sent[0].tokens["openai-responses"], /^cap1\.[^.]+\.[^.]+$/);
  assert.match(sent[0].sandbox_ws_token, /^cap1\.[^.]+\.[^.]+$/);
  assert.ok((await issueProxyCapabilities(host))["openai-responses"]);
});

test("proxy capability refresh normalizes an HTTPS primary repository without .git", async () => {
  const { host } = createFakeHost({ repo: "https://github.com/acme/app" }, {
    workerEnv: {
      CODEVIL_PROXY_SIGNING_SECRET: "test-signing-secret",
      CODEVIL_API_KEY: "test-key",
      GITHUB_PAT: "github-pat",
      Sandbox: {},
      DB: {},
    },
  });
  const { ws, sent } = createWsRecorder();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response("ok");
  };
  try {
    await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "proxy_capabilities_refresh_request" }));

    assert.equal(sent[0].type, "proxy_capabilities");
    const capability = sent[0].tokens.git;
    assert.match(capability, /^cap1\.[^.]+\.[^.]+$/);
    const authorization = `Basic ${Buffer.from(`x-access-token:${capability}`).toString("base64")}`;
    const response = await handleSandboxProxy(new Request(
      "https://worker.test/sandbox-proxy/sessions/ses_test/github/acme/app.git/info/refs?service=git-upload-pack",
      { headers: { authorization } },
    ), host.workerEnv);

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://github.com/acme/app.git/info/refs?service=git-upload-pack");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxy capabilities reject unsafe primary repository forms", async () => {
  for (const repo of [
    "https://user@github.com/acme/app",
    "https://github.com/acme/app?ref=main",
    "https://github.com/acme/app#readme",
    "https://github.com/acme/app/extra",
    "https://gitlab.com/acme/app",
    "https://github.com/acme/../private",
  ]) {
    const { host } = createFakeHost({ repo }, {
      workerEnv: { CODEVIL_PROXY_SIGNING_SECRET: "test-signing-secret", CODEVIL_API_KEY: "test-key", Sandbox: {}, DB: {} },
    });
    await assert.rejects(() => issueProxyCapabilities(host), /Session repository must be a github\.com HTTPS repository/, repo);
  }
});

test("handleSandboxCloneStarted transitions from provisioning_sandbox to cloning_repo", () => {
  const { host, transitions, directoryPatches } = createFakeHost({ state: "provisioning_sandbox" });

  handleSandboxCloneStarted(host);

  assert.equal(host.meta.state, "cloning_repo");
  assert.deepEqual(transitions.at(-1), { from: "provisioning_sandbox", to: "cloning_repo" });
  assert.deepEqual(directoryPatches.at(-1), { sandbox_state: "cloning" });
});

test("handleSandboxCloneStarted is a no-op outside provisioning_sandbox", () => {
  const { host, transitions, directoryPatches } = createFakeHost({ state: "ready" });

  handleSandboxCloneStarted(host);

  assert.equal(host.meta.state, "ready");
  assert.equal(transitions.length, 0);
  assert.equal(directoryPatches.length, 0);
});

test("handleSandboxCloneComplete transitions to ready and broadcasts room_ready", async () => {
  const fixture = createFakeHost({
    state: "cloning_repo",
  });

  handleSandboxCloneComplete(fixture.host);
  await fixture.drainBackgroundWork();

  assert.equal(fixture.host.meta.state, "ready");
  assert.deepEqual(fixture.transitions.at(-1), { from: "cloning_repo", to: "ready" });
  assert.deepEqual(fixture.directoryPatches.at(-1), { room_state: "ready", sandbox_state: "ready" });
  assert.ok(fixture.broadcasts.some((e) => e.type === "room_ready"));
  assert.ok(fixture.broadcasts.some((e) => e.type === "status" && /ready/i.test(e.message)));
});

test("handleSandboxCloneComplete starts one cache attempt before queued Agent Runs can write", async () => {
  const queuedRun = createAgentRun({
    actor,
    text: "use the prepared workspace",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_waiting_for_cache",
  });
  const sql = createCacheJobSql();
  const fixture = createFakeHost(
    { state: "cloning_repo", queued_runs: [queuedRun] },
    { sql },
  );
  let backupCalls = 0;
  let releaseBackup;
  const backupPending = new Promise((resolve) => { releaseBackup = resolve; });

  handleSandboxCloneComplete(fixture.host, async () => {
    backupCalls += 1;
    return backupPending;
  });

  assert.equal(backupCalls, 1);
  assert.equal(sql.row.status, "running");
  assert.equal(fixture.host.meta.active_run ?? null, null);
  assert.deepEqual(fixture.host.meta.queued_runs.map((run) => run.id), ["run_waiting_for_cache"]);

  releaseBackup({ created: true, snapshotId: "wsc_clone_context" });
  await fixture.drainBackgroundWork();

  assert.equal(sql.row.status, "ready");
  assert.equal(fixture.host.meta.active_run.id, "run_waiting_for_cache");
  assert.deepEqual(fixture.host.meta.queued_runs, []);
});

test("handleSandboxCloneComplete drains queued Agent Runs after cache failure", async () => {
  const queuedRun = createAgentRun({
    actor,
    text: "continue without a warm cache",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_after_cache_failure",
  });
  const sql = createCacheJobSql();
  const fixture = createFakeHost(
    { state: "cloning_repo", queued_runs: [queuedRun] },
    { sql },
  );

  handleSandboxCloneComplete(fixture.host, async () => ({
    created: false,
    phase: "backup",
    reason: "backup reset the Durable Object",
  }));
  await fixture.drainBackgroundWork();

  assert.equal(sql.row.status, "failed");
  assert.equal(fixture.host.meta.active_run.id, "run_after_cache_failure");
  assert.deepEqual(fixture.host.meta.queued_runs, []);
});

test("interrupted cache work is nonblocking when recovery alarms drain queued Agent Runs", () => {
  const queuedRun = createAgentRun({
    actor,
    text: "continue after restart",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_after_cache_interruption",
  });
  const sql = createCacheJobSql();
  sql.exec(
    "INSERT INTO workspace_cache_jobs",
    "workspace",
    "github.com/acme/app",
    "workspace-cache-v3",
    "ses_test",
    1_000,
    "2026-06-03T00:00:00.000Z",
    "2026-06-03T00:00:00.000Z",
  );
  sql.row.status = "interrupted";
  sql.row.next_attempt_at = null;
  const fixture = createFakeHost(
    { state: "ready", queued_runs: [queuedRun] },
    { sql },
  );

  drainQueuedAgentWorkIfWorkspaceCacheSettled(fixture.host);

  assert.equal(fixture.host.meta.active_run.id, "run_after_cache_interruption");
  assert.deepEqual(fixture.host.meta.queued_runs, []);
});

test("handleSandboxPlanReady stores plan and requests approval during planning", () => {
  const active = createAgentRun({
    actor,
    text: "draft plan",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_plan",
    planFirst: true,
  });
  active.state = "thinking";

  const cost = { input_tokens: 10, output_tokens: 20, total_cost_usd: 0.01 };
  const { host, broadcasts, transitions } = createFakeHost({
    state: "planning",
    active_run: active,
  });

  handleSandboxPlanReady(host, "# Plan markdown", cost);

  assert.equal(host.meta.latest_plan, "# Plan markdown");
  assert.equal(host.meta.cost_total_usd, 0.01);
  assert.equal(host.meta.state, "awaiting_approval");
  assert.deepEqual(transitions.at(-1), { from: "planning", to: "awaiting_approval" });
  const approval = broadcasts.find((e) => e.type === "approval_requested");
  assert.ok(approval);
  assert.equal(approval.plan, "# Plan markdown");
  assert.equal(approval.run_id, "run_plan");
});

test("dispatchSandboxSocketMessage error during executing fails the active run and returns to ready", async () => {
  const active = createAgentRun({
    actor,
    text: "run task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_exec",
  });
  active.state = "executing";

  const { host, broadcasts, transitions } = createFakeHost({
    state: "executing",
    active_run: active,
  });
  const { ws } = createWsRecorder();

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "error", message: "agent crashed" }));

  assert.equal(host.meta.state, "ready");
  assert.ok(transitions.some((t) => t.to === "ready"));
  const failed = broadcasts.find((e) => e.type === "agent_run_failed");
  assert.ok(failed);
  assert.equal(failed.run_id, "run_exec");
  assert.equal(failed.message, "agent crashed");
});

test("dispatchSandboxSocketMessage maps agent_turn_failed to the matching run failure", async () => {
  const active = createAgentRun({
    actor,
    text: "run task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_exec",
  });
  active.state = "executing";

  const { host, broadcasts, transitions } = createFakeHost({
    state: "executing",
    active_run: active,
  });
  const { ws, sent } = createWsRecorder();

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({
    type: "agent_turn_failed",
    run_id: "run_exec",
    message: "provider request failed",
  }));

  assert.equal(sent.length, 0);
  assert.equal(host.meta.state, "ready");
  assert.ok(transitions.some((transition) => transition.to === "ready"));
  assert.ok(!broadcasts.some((event) => event.type === "agent_response"));
  const failed = broadcasts.find((event) => event.type === "agent_run_failed");
  assert.equal(failed?.run_id, "run_exec");
  assert.equal(failed?.message, "provider request failed");
});

test("dispatchSandboxSocketMessage error outside executing transitions session to failed", async () => {
  const { host, broadcasts, transitions } = createFakeHost({ state: "cloning_repo" });
  const { ws } = createWsRecorder();

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "error", message: "clone failed" }));

  assert.equal(host.meta.state, "failed");
  assert.deepEqual(transitions.at(-1), { from: "cloning_repo", to: "failed" });
  assert.ok(broadcasts.some((e) => e.type === "error" && e.message === "clone failed"));
});

test("provisionSessionSandbox failure transitions to failed and patches directory", async () => {
  const { host, broadcasts, transitions, directoryPatches } = createFakeHost(
    { state: "initializing" },
    { tracer: createFakeTracer() },
  );

  await provisionSessionSandbox(host);

  assert.equal(host.meta.state, "failed");
  assert.deepEqual(transitions, [
    { from: "initializing", to: "provisioning_sandbox" },
    { from: "provisioning_sandbox", to: "failed" },
  ]);
  assert.deepEqual(directoryPatches, [
    { sandbox_state: "provisioning" },
    { room_state: "failed", sandbox_state: "failed" },
  ]);
  assert.ok(broadcasts.some((e) => e.type === "error"));
});
