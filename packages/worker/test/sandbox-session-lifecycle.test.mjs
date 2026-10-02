import assert from "node:assert/strict";
import test from "node:test";
import { handleAgentRequest } from "../dist/orchestrator/cli-handlers.js";
import { hashPreviewToken, proxyPreviewRequest } from "../dist/orchestrator/preview.js";
import { drainQueuedAgentWorkIfReady } from "../dist/orchestrator/sandbox-handlers.js";
import { connectSandboxHandle, sandboxDiagnosticsResponse, sandboxLogsResponse } from "../dist/orchestrator/sandbox-access.js";
import { handlePreviewStart, handlePreviewStop } from "../dist/orchestrator/cli-handlers.js";
import {
  clearStalePausedMarker,
  flushPendingPreviewAction,
  idlePauseInput,
  recordSessionActivity,
  expireSessionAtMaxTime,
  isSandboxPausing,
  pauseIdleSandbox,
  prepareAuthenticatedPreview,
  renewSandboxLeaseIfDue,
  resumeSandbox,
  sandboxAlarmDeadlines,
  sandboxSocketAttached,
  terminateSandbox,
} from "../dist/orchestrator/sandbox-session-lifecycle.js";
import {
  closeSandboxSockets,
  isLiveSandboxSocket,
  isUnexpectedSandboxDisconnect,
  liveSandboxSockets,
  sandboxConnectionMode,
} from "../dist/sandbox-connection.js";
import { SandboxNotFoundError } from "../dist/sandbox-provider/types.js";
import { sandboxProviderMaxLeaseMs } from "../dist/sandbox-provider/index.js";
import { loadSessionMeta } from "../dist/orchestrator/session-meta.js";
import {
  actor,
  createDefaultMeta,
  createFakeHost,
  createFakeSandboxSocket,
  createFakeSandboxProvider,
  createFakeSql,
  createRecordingTracer,
} from "./helpers/fake-host.mjs";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const idleMeta = {
  state: "ready",
  sandbox_provider: "e2b",
  sandbox_ref: { provider: "e2b", id: "sbx_1" },
  max_idle_time: "10m",
  last_activity_at: "2026-10-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  max_time: "2h",
};
const pausedMeta = { ...idleMeta, sandbox_paused_at: "2026-10-01T00:10:00.000Z", expected_close: true };
const NO_DELAY = { retryDelaysMs: [0, 0, 0] };

function queuedRun(id = "run_q") {
  return { id, state: "queued", text: "t", actor: { id: "u", name: "U" }, created_at: "t" };
}

function callNames(handle) {
  return handle.calls.map(([name]) => name);
}

// --- pause ---

test("pauses after max_idle_time, closes sandbox sockets, and marks the sandbox paused", async () => {
  const { host, handle, directoryPatches, broadcasts } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), true);
  assert.deepEqual(callNames(handle), ["pause"]);
  assert.equal(host.meta.expected_close, true);
  assert.equal(host.meta.sandbox_paused_at, new Date(T0 + 600_000).toISOString());
  assert.equal(host.ctx.getWebSockets("sandbox").length, 0);
  assert.deepEqual(directoryPatches.at(-1), { sandbox_state: "paused" });
  assert.ok(broadcasts.some((event) => event.type === "status" && event.message === "Sandbox paused (idle)."));
});

test("does not pause before max_idle_time elapses", async () => {
  const { host, handle } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  assert.equal(await pauseIdleSandbox(host, T0 + 599_999), false);
  assert.equal(handle.calls.length, 0);
});

test("does not pause during an active run", async () => {
  const { host, handle } = createFakeHost(
    { ...idleMeta, active_run: { id: "run_1", state: "thinking" } },
    { e2b: true, sandboxConnected: true },
  );
  assert.equal(await pauseIdleSandbox(host, T0 + 3_600_000), false);
  assert.equal(handle.calls.length, 0);
});

test("does not pause with a queued run or while cloning", async () => {
  const idle = T0 + 3_600_000;
  const queued = createFakeHost({ ...idleMeta, queued_runs: [queuedRun()] }, { e2b: true, sandboxConnected: true });
  assert.equal(await pauseIdleSandbox(queued.host, idle), false);

  const cloning = createFakeHost({ ...idleMeta, state: "cloning_repo" }, { e2b: true, sandboxConnected: true });
  assert.equal(await pauseIdleSandbox(cloning.host, idle), false);

  for (const { handle } of [queued, cloning]) assert.equal(handle.calls.length, 0);
});

test("does not pause mid-reconnect or without an attached sandbox socket", async () => {
  const idle = T0 + 3_600_000;
  const reconnecting = createFakeHost(
    { ...idleMeta, sandbox_disconnected_at: "2026-10-01T00:09:30.000Z" },
    { e2b: true, sandboxConnected: true },
  );
  assert.equal(await pauseIdleSandbox(reconnecting.host, idle), false);

  const detached = createFakeHost(idleMeta, { e2b: true, sandboxConnected: false });
  assert.equal(await pauseIdleSandbox(detached.host, idle), false);

  assert.equal(reconnecting.handle.calls.length, 0);
  assert.equal(detached.handle.calls.length, 0);
});

test("a pause failure leaves the sandbox running and clears expected_close", async () => {
  const { host, closedSandboxSockets } = createFakeHost(idleMeta, {
    e2b: true,
    sandboxConnected: true,
    pauseError: new Error("boom"),
  });
  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), false);
  assert.equal(host.meta.expected_close, false);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.equal(host.ctx.getWebSockets("sandbox").length, 1);
  assert.deepEqual(closedSandboxSockets, []);
});

test("a pause failure is logged with secrets redacted", async () => {
  const tracer = createRecordingTracer();
  const { host } = createFakeHost(idleMeta, {
    e2b: true,
    sandboxConnected: true,
    tracer,
    pauseError: new Error("pause rejected for token sekret-traffic-token"),
  });
  host.redactionSecrets.push("sekret-traffic-token");
  await pauseIdleSandbox(host, T0 + 600_000);
  const entry = tracer.logs.find((log) => log.name === "sandbox.pause.failed");
  assert.ok(entry);
  assert.ok(!JSON.stringify(entry).includes("sekret-traffic-token"));
});

test("pausing a vanished sandbox fails the session with Sandbox expired", async () => {
  const { host, broadcasts } = createFakeHost(idleMeta, {
    e2b: true,
    sandboxConnected: true,
    pauseError: new SandboxNotFoundError(),
  });
  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), false);
  assert.equal(host.meta.state, "failed");
  assert.ok(broadcasts.some((event) => event.type === "error" && event.message === "Sandbox expired."));
});

test("a request arriving mid-pause queues, then triggers a resume once the pause lands", async () => {
  const { host, handle, resumeRequests } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  let release;
  handle.pause = () => new Promise((resolve) => { release = resolve; });

  const pausing = pauseIdleSandbox(host, T0 + 600_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isSandboxPausing(host), true);
  assert.equal(sandboxSocketAttached(host), false);
  // A second tick does not start a second pause.
  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), false);

  handleAgentRequest(host, "do the thing", actor, false);
  assert.equal(host.meta.active_run ?? null, null);
  assert.equal(host.meta.queued_runs.length, 1);
  assert.equal(resumeRequests.count, 0);

  release();
  assert.equal(await pausing, true);
  assert.equal(isSandboxPausing(host), false);
  assert.equal(resumeRequests.count, 1);
});

test("a session that ends mid-pause is not marked paused", async () => {
  const { host, handle, directoryPatches } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  let release;
  handle.pause = () => new Promise((resolve) => { release = resolve; });

  const pausing = pauseIdleSandbox(host, T0 + 600_000);
  await new Promise((resolve) => setImmediate(resolve));
  host.meta.state = "failed";
  release();

  assert.equal(await pausing, false);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.ok(!directoryPatches.some((patch) => patch.sandbox_state === "paused"));
});

// --- resume ---

test("resume connects once for concurrent triggers and writes a fresh ws token", async () => {
  const { host, handle, provider } = createFakeHost(pausedMeta, { e2b: true });
  await Promise.all([resumeSandbox(host), resumeSandbox(host)]);
  assert.equal(provider.connectCalls, 1);
  assert.deepEqual(handle.calls.find(([name]) => name === "writeFile"), [
    "writeFile",
    "/run/codevil/ws-token",
    "fresh_token",
    { mode: 0o600, owner: "codevil" },
  ]);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.equal(host.meta.expected_close, false);
  assert.ok(host.meta.sandbox_lease_renewed_at);
});

test("resume connects with the lease cap and the stored provider secret, and redacts the secret", async () => {
  const { host, provider, storage } = createFakeHost(
    { ...pausedMeta, created_at: new Date().toISOString() },
    { e2b: true, secret: "sekret-handle" },
  );
  storage.set("codevil:sandbox_secret", "stored-secret");
  await resumeSandbox(host);
  const [options] = provider.connectOptions;
  assert.equal(options.secret, "stored-secret");
  assert.ok(options.leaseMs > 0 && options.leaseMs <= sandboxProviderMaxLeaseMs({}, "e2b"));
  assert.ok(host.redactionSecrets.includes("sekret-handle"));
});

test("resume announces itself, updates the directory, and starts the reconnect grace", async () => {
  const { host, broadcasts, directoryPatches } = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: false });
  await resumeSandbox(host);
  assert.ok(broadcasts.some((event) => event.type === "status" && event.message === "Sandbox resumed."));
  assert.deepEqual(directoryPatches.at(-1), { sandbox_state: "ready" });
  assert.ok(host.meta.sandbox_disconnected_at);
});

test("resume does not start the reconnect grace when the agent already reconnected", async () => {
  const { host } = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: true });
  await resumeSandbox(host);
  assert.equal(host.meta.sandbox_disconnected_at, undefined);
});

test("resume of a session that is not paused does nothing", async () => {
  const { host, provider } = createFakeHost(idleMeta, { e2b: true });
  await resumeSandbox(host);
  assert.equal(provider.connectCalls, 0);
});

test("resume of a vanished sandbox fails the session with Sandbox expired", async () => {
  const { host, broadcasts, directoryPatches } = createFakeHost(
    { ...idleMeta, sandbox_paused_at: "2026-10-01T00:10:00.000Z" },
    { e2b: true, connectError: new SandboxNotFoundError() },
  );
  await resumeSandbox(host);
  assert.equal(host.meta.state, "failed");
  assert.ok(broadcasts.some((event) => event.type === "error" && event.message === "Sandbox expired."));
  assert.deepEqual(directoryPatches.at(-1), { room_state: "failed", sandbox_state: "failed", active_run_state: null });
});

test("resume retries three times then fails, cancels queued runs, and destroys the sandbox", async () => {
  const { host, handle, provider, broadcasts, directoryPatches } = createFakeHost(
    { ...idleMeta, sandbox_paused_at: "x", queued_runs: [queuedRun()] },
    { e2b: true, connectError: new Error("503") },
  );
  await resumeSandbox(host, NO_DELAY);
  assert.equal(provider.connectCalls, 3);
  assert.equal(host.meta.state, "failed");
  assert.ok(
    broadcasts.some(
      (event) => event.type === "agent_run_failed" && event.run_id === "run_q" && event.message === "Sandbox failed to resume.",
    ),
  );
  assert.deepEqual(host.meta.queued_runs, []);
  assert.deepEqual(directoryPatches.find((patch) => patch.room_state === "failed"), {
    room_state: "failed",
    sandbox_state: "failed",
    active_run_state: null,
  });
  assert.deepEqual(handle.calls.find(([name]) => name === "destroy"), ["destroy", "resume failed"]);
  assert.equal(host.meta.sandbox_paused_at, undefined);
});

test("resume recovers when a retry succeeds", async () => {
  const { host, provider, handle } = createFakeHost(pausedMeta, { e2b: true });
  const connect = provider.connect;
  provider.connect = async (...args) => {
    if (provider.connectCalls === 0) {
      provider.connectCalls += 1;
      throw new Error("transient");
    }
    return connect(...args);
  };
  await resumeSandbox(host, NO_DELAY);
  assert.equal(host.meta.state, "ready");
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.ok(callNames(handle).includes("writeFile"));
});

test("resume failures are logged with secrets redacted", async () => {
  const tracer = createRecordingTracer();
  const { host } = createFakeHost(pausedMeta, {
    e2b: true,
    tracer,
    connectError: new Error("connect failed with sekret-traffic-token"),
  });
  host.redactionSecrets.push("sekret-traffic-token");
  await resumeSandbox(host, NO_DELAY);
  const entries = tracer.logs.filter((log) => log.name === "sandbox.resume.failed");
  assert.equal(entries.length, 3);
  assert.ok(!JSON.stringify(tracer.logs).includes("sekret-traffic-token"));
});

test("a session stopped mid-resume stays failed and is not resurrected", async () => {
  const { host, provider, handle } = createFakeHost(pausedMeta, { e2b: true });
  let release;
  provider.connect = () => new Promise((resolve) => { release = () => resolve(handle); });

  const resuming = resumeSandbox(host);
  await new Promise((resolve) => setImmediate(resolve));
  // Stop the session the way the Orchestrator does: fail it, then tear the sandbox down.
  host.transition("failed");
  await terminateSandbox(host, "stopped by user");
  release();
  await resuming;

  assert.equal(host.meta.state, "failed");
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.equal(host.meta.expected_close, true);
  assert.ok(!callNames(handle).includes("writeFile"), "no token is written for a resume that lost the race");
});

test("after resume the queued run starts exactly once when the agent reconnects", async () => {
  const { host, sandboxMessages, sandboxSockets } = createFakeHost(
    { ...pausedMeta, queued_runs: [queuedRun()] },
    { e2b: true, sandboxConnected: false },
  );
  // Paused: no socket, so nothing drains.
  drainQueuedAgentWorkIfReady(host);
  assert.equal(sandboxMessages.length, 0);

  await Promise.all([resumeSandbox(host), resumeSandbox(host)]);
  // Resumed, but the agent has not reconnected yet.
  drainQueuedAgentWorkIfReady(host);
  assert.equal(sandboxMessages.length, 0);
  assert.equal(host.meta.queued_runs.length, 1);

  sandboxSockets.push({});
  drainQueuedAgentWorkIfReady(host);
  drainQueuedAgentWorkIfReady(host);
  assert.deepEqual(sandboxMessages.map((message) => message.type), ["agent_turn"]);
  assert.equal(host.meta.queued_runs.length, 0);
  assert.equal(host.meta.active_run.id, "run_q");
});

test("a paused sandbox reconnects in resume mode", () => {
  assert.equal(sandboxConnectionMode("ready", undefined, 0), "resume");
  assert.equal(sandboxConnectionMode("ready", undefined, 1), "reject");
});

test("a late close of the old socket is ignored only when a newer LIVE socket exists", () => {
  const oldSocket = createFakeSandboxSocket();
  const base = { state: "ready", closedSocket: oldSocket };

  // The agent dropped and nothing replaced it: a real interruption (current socket's close is handled).
  assert.equal(isUnexpectedSandboxDisconnect({ ...base, sandboxSockets: [oldSocket] }), true);
  // The agent already reconnected on a newer live socket: the old socket's late close is stale.
  assert.equal(isUnexpectedSandboxDisconnect({ ...base, sandboxSockets: [oldSocket, createFakeSandboxSocket()] }), false);
  // A newer socket the DO already closed, or one that is not OPEN, is not a live replacement.
  const closing = createFakeSandboxSocket({ closing: true });
  const closed = Object.assign(createFakeSandboxSocket(), { readyState: 3 });
  assert.equal(isUnexpectedSandboxDisconnect({ ...base, sandboxSockets: [oldSocket, closing, closed] }), true);
  // Closes the DO initiated, and closes after the session ended, are never interruptions.
  assert.equal(isUnexpectedSandboxDisconnect({ ...base, sandboxSockets: [oldSocket], expectedClose: true }), false);
  assert.equal(isUnexpectedSandboxDisconnect({ ...base, sandboxSockets: [oldSocket], state: "failed" }), false);
});

test("live sandbox sockets exclude sockets the DO closed or that are not OPEN", () => {
  const live = createFakeSandboxSocket();
  const closing = createFakeSandboxSocket();
  const notOpen = Object.assign(createFakeSandboxSocket(), { readyState: 2 });
  const bare = {};
  const ctx = { getWebSockets: (tag) => (tag === "sandbox" ? [live, closing, notOpen, bare] : []) };

  closeSandboxSockets({ getWebSockets: () => [closing] }, "sandbox paused");

  assert.deepEqual(closing.closeCalls, [[1000, "sandbox paused"]]);
  // The closing flag merges into the existing attachment instead of replacing it.
  assert.deepEqual(closing.deserializeAttachment(), { sandbox: { aud: "sandbox_ws", role: "sandbox" }, closing: true });
  assert.equal(isLiveSandboxSocket(closing), false);
  assert.deepEqual(liveSandboxSockets(ctx), [live, bare]);
});

test("a stale paused marker with a live agent socket is cleared; a real pause is not", () => {
  const stale = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: true });
  assert.equal(clearStalePausedMarker(stale.host), true);
  assert.equal(stale.host.meta.sandbox_paused_at, undefined);
  assert.equal(stale.host.meta.expected_close, false);

  const paused = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: false });
  assert.equal(clearStalePausedMarker(paused.host), false);
  assert.ok(paused.host.meta.sandbox_paused_at);
});

// --- lease renewal ---

test("lease renewal runs on schedule and not while paused", async () => {
  const { host, handle } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  await renewSandboxLeaseIfDue(host, T0 + 5 * 60_000);
  assert.equal(handle.calls.filter(([name]) => name === "renewLease").length, 1);
  assert.equal(host.meta.sandbox_lease_renewed_at, new Date(T0 + 5 * 60_000).toISOString());
  host.meta.sandbox_paused_at = "x";
  await renewSandboxLeaseIfDue(host, T0 + 20 * 60_000);
  assert.equal(handle.calls.filter(([name]) => name === "renewLease").length, 1);
});

test("lease renewal waits for its interval and skips terminal sessions", async () => {
  const early = createFakeHost(idleMeta, { e2b: true });
  await renewSandboxLeaseIfDue(early.host, T0 + 5 * 60_000 - 1);
  assert.equal(early.handle.calls.length, 0);

  const ended = createFakeHost({ ...idleMeta, state: "completed" }, { e2b: true });
  await renewSandboxLeaseIfDue(ended.host, T0 + 60 * 60_000);
  assert.equal(ended.handle.calls.length, 0);
});

test("a renewal failure is logged redacted and retried, not fatal", async () => {
  const tracer = createRecordingTracer();
  const { host } = createFakeHost(idleMeta, {
    e2b: true,
    tracer,
    renewError: new Error("renew failed sekret-traffic-token"),
  });
  host.redactionSecrets.push("sekret-traffic-token");
  await renewSandboxLeaseIfDue(host, T0 + 5 * 60_000);
  assert.equal(host.meta.state, "ready");
  assert.equal(host.meta.sandbox_lease_renewed_at, undefined);
  assert.ok(tracer.logs.some((log) => log.name === "sandbox.lease_renew.failed"));
  assert.ok(!JSON.stringify(tracer.logs).includes("sekret-traffic-token"));
});

test("a renewal that finds the sandbox gone fails the session", async () => {
  const { host } = createFakeHost(idleMeta, { e2b: true, renewError: new SandboxNotFoundError() });
  await renewSandboxLeaseIfDue(host, T0 + 5 * 60_000);
  assert.equal(host.meta.state, "failed");
});

// --- alarm deadlines ---

test("alarm deadlines: idle pause and lease renewal for an idle E2B session", () => {
  const { host } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  assert.deepEqual(sandboxAlarmDeadlines(host), {
    idlePauseAt: T0 + 600_000,
    leaseRenewAt: T0 + 5 * 60_000,
  });
});

test("alarm deadlines: no idle pause unless ready, attached, and without runs", () => {
  const cases = [
    [{ state: "cloning_repo" }, { sandboxConnected: true }],
    [{ active_run: { id: "run_1", state: "thinking" } }, { sandboxConnected: true }],
    [{ queued_runs: [queuedRun()] }, { sandboxConnected: true }],
    [{}, { sandboxConnected: false }],
    [{ sandbox_disconnected_at: "2026-10-01T00:09:30.000Z" }, { sandboxConnected: true }],
  ];
  for (const [meta, options] of cases) {
    const { host } = createFakeHost({ ...idleMeta, ...meta }, { e2b: true, ...options });
    assert.equal(sandboxAlarmDeadlines(host).idlePauseAt, null, JSON.stringify(meta));
  }
});

test("alarm deadlines: nothing while paused, terminal, or without a sandbox ref", () => {
  const paused = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: true });
  assert.deepEqual(sandboxAlarmDeadlines(paused.host), { idlePauseAt: null, leaseRenewAt: null });

  const ended = createFakeHost({ ...idleMeta, state: "failed" }, { e2b: true, sandboxConnected: true });
  assert.deepEqual(sandboxAlarmDeadlines(ended.host), { idlePauseAt: null, leaseRenewAt: null });

  const noRef = createFakeHost({ ...idleMeta, sandbox_ref: undefined }, { e2b: true, sandboxConnected: true });
  assert.equal(sandboxAlarmDeadlines(noRef.host).leaseRenewAt, null);
});

// --- Cloudflare is unaffected ---

test("the idle and lease path is a no-op for a Cloudflare session", async () => {
  const resolved = [];
  const { host, broadcasts, directoryPatches } = createFakeHost(
    {
      state: "ready",
      sandbox_provider: "cloudflare",
      sandbox_ref: { provider: "cloudflare", id: "ses_test" },
      max_idle_time: "10m",
      last_activity_at: "2026-10-01T00:00:00.000Z",
      created_at: "2026-10-01T00:00:00.000Z",
      max_time: "2h",
    },
    { sandboxConnected: true },
  );
  const sandboxHandle = host.sandboxHandle;
  host.sandboxHandle = async () => {
    resolved.push("handle");
    return sandboxHandle.call(host);
  };
  const farFuture = T0 + 24 * 3_600_000;

  assert.deepEqual(sandboxAlarmDeadlines(host), { idlePauseAt: null, leaseRenewAt: null });
  assert.equal(await pauseIdleSandbox(host, farFuture), false);
  await renewSandboxLeaseIfDue(host, farFuture);
  await resumeSandbox(host);

  assert.deepEqual(resolved, []);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.equal(host.meta.expected_close, undefined);
  assert.equal(host.meta.sandbox_lease_renewed_at, undefined);
  assert.equal(host.ctx.getWebSockets("sandbox").length, 1);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(directoryPatches, []);
});

// --- activity and resume triggers ---

test("an Agent Request on a paused session queues, resumes once, and records activity", () => {
  const { host, resumeRequests, activity, broadcasts, sandboxMessages } = createFakeHost(
    { ...pausedMeta, last_activity_at: "2026-10-01T00:00:00.000Z" },
    { e2b: true, sandboxConnected: false },
  );
  handleAgentRequest(host, "wake up", actor, false);

  assert.equal(resumeRequests.count, 1);
  assert.equal(activity.count, 1);
  assert.notEqual(host.meta.last_activity_at, "2026-10-01T00:00:00.000Z");
  assert.equal(host.meta.queued_runs.length, 1);
  assert.equal(host.meta.active_run ?? null, null);
  assert.ok(broadcasts.some((event) => event.type === "agent_request_queued"));
  assert.deepEqual(sandboxMessages, []);
});

test("an Agent Request on a running session records activity without resuming", () => {
  const { host, resumeRequests, activity } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  handleAgentRequest(host, "go", actor, false);
  assert.equal(activity.count, 1);
  assert.equal(resumeRequests.count, 0);
});

test("an empty Agent Request does not count as activity", () => {
  const { host, activity } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  handleAgentRequest(host, "   ", actor, false);
  assert.equal(activity.count, 0);
});

// --- teardown ---

test("max_time on a paused session destroys the sandbox", async () => {
  const { host, handle, closedSandboxSockets, broadcasts } = createFakeHost(
    { ...pausedMeta, max_time: "1h" },
    { e2b: true, sandboxConnected: false },
  );
  assert.equal(await expireSessionAtMaxTime(host, T0 + 3_599_999), false);
  assert.equal(handle.calls.length, 0);

  assert.equal(await expireSessionAtMaxTime(host, T0 + 3_600_000), true);
  assert.equal(host.meta.state, "timed_out");
  assert.deepEqual(handle.calls.find(([name]) => name === "destroy"), ["destroy", "timed out"]);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.deepEqual(closedSandboxSockets, ["timed out"]);
  assert.ok(broadcasts.some((event) => event.type === "error" && event.message === "Session timed out after 1h."));
});

test("stopping a paused session destroys the sandbox and clears the paused marker", async () => {
  const { host, handle } = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: false });
  await terminateSandbox(host, "stopped by user");
  assert.deepEqual(handle.calls.find(([name]) => name === "destroy"), ["destroy", "stopped by user"]);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.equal(host.meta.expected_close, true);
});

test("a destroy failure at teardown is logged redacted and not thrown", async () => {
  const tracer = createRecordingTracer();
  const { host, handle } = createFakeHost(pausedMeta, { e2b: true, tracer });
  handle.destroy = async () => { throw new Error("kill failed sekret-traffic-token"); };
  host.redactionSecrets.push("sekret-traffic-token");
  await terminateSandbox(host, "stopped by user");
  assert.ok(tracer.logs.some((log) => log.name === "sandbox.stop.failed"));
  assert.ok(!JSON.stringify(tracer.logs).includes("sekret-traffic-token"));
});

// --- preview ---

const PREVIEW_TOKEN = "ses-test-secrettoken";

async function previewHost(metaOverrides, options = {}) {
  const fake = createFakeHost(
    {
      ...pausedMeta,
      preview_active: true,
      preview_port: 5173,
      preview_token_hash: await hashPreviewToken(PREVIEW_TOKEN),
      ...metaOverrides,
    },
    { e2b: true, sandboxConnected: false, ...options },
  );
  fake.handle.fetchPort = async () => new Response("preview body");
  return fake;
}

function previewRequest(token) {
  return new Request(`https://worker.example/sessions/ses_test/preview/${token}/`);
}

function proxy(fake, token, timeoutMs) {
  return proxyPreviewRequest(
    previewRequest(token),
    fake.host.meta,
    token,
    () => fake.host.sandboxHandle(),
    { beforeProxy: () => prepareAuthenticatedPreview(fake.host, timeoutMs) },
  );
}

test("an authenticated preview request resumes a paused sandbox, records activity, and proxies", async () => {
  const fake = await previewHost({});
  const response = await proxy(fake, PREVIEW_TOKEN);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "preview body");
  assert.equal(fake.provider.connectCalls, 1);
  assert.equal(fake.host.meta.sandbox_paused_at, undefined);
  assert.equal(fake.activity.count, 1);
});

test("the preview resume path writes a fresh ws token before the agent reconnects", async () => {
  const fake = await previewHost({});
  await proxy(fake, PREVIEW_TOKEN);
  assert.deepEqual(fake.handle.calls.find(([name]) => name === "writeFile"), [
    "writeFile",
    "/run/codevil/ws-token",
    "fresh_token",
    { mode: 0o600, owner: "codevil" },
  ]);
});

test("an authenticated preview request on a running sandbox records activity without resuming", async () => {
  const fake = await previewHost({ sandbox_paused_at: undefined, expected_close: false });
  const response = await proxy(fake, PREVIEW_TOKEN);
  assert.equal(response.status, 200);
  assert.equal(fake.provider.connectCalls, 0);
  assert.equal(fake.activity.count, 1);
});

test("an unknown preview token neither resumes the sandbox nor records activity", async () => {
  const fake = await previewHost({});
  const response = await proxy(fake, "ses-test-wrongtoken");
  assert.equal(response.status, 404);
  assert.equal(fake.provider.connectCalls, 0);
  assert.equal(fake.activity.count, 0);
  assert.ok(fake.host.meta.sandbox_paused_at);
});

test("an inactive or ended preview neither resumes the sandbox nor records activity", async () => {
  const inactive = await previewHost({ preview_active: false });
  assert.equal((await proxy(inactive, PREVIEW_TOKEN)).status, 404);

  const ended = await previewHost({ state: "completed" });
  assert.equal((await proxy(ended, PREVIEW_TOKEN)).status, 410);

  for (const fake of [inactive, ended]) {
    assert.equal(fake.provider.connectCalls, 0);
    assert.equal(fake.activity.count, 0);
  }
});

test("a preview request answers 503 with Retry-After when the resume is slow, and the resume continues", async () => {
  const fake = await previewHost({});
  let release;
  fake.provider.connect = () => new Promise((resolve) => { release = () => resolve(fake.handle); });

  const response = await proxy(fake, PREVIEW_TOKEN, 10);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "2");
  assert.equal(await response.text(), "Sandbox is resuming. Retry shortly.");

  release();
  await fake.drainBackgroundWork();
  assert.equal(fake.host.meta.sandbox_paused_at, undefined);
});

test("a preview request on a session whose resume failed answers 410, not a proxied error", async () => {
  const fake = await previewHost({}, { connectError: new SandboxNotFoundError() });
  const response = await proxy(fake, PREVIEW_TOKEN);
  assert.equal(response.status, 410);
  assert.equal(fake.host.meta.state, "failed");
});

// --- live sockets: a DO-closed socket may linger while its paused peer is frozen ---

for (const linger of [false, true]) {
  const mode = linger ? "closed sockets linger in getWebSockets" : "closed sockets are removed";

  test(`pause, request, resume, reconnect (${mode})`, async () => {
    const { host, sandboxSockets, sandboxMessages, resumeRequests } = createFakeHost(idleMeta, {
      e2b: true,
      sandboxConnected: true,
      lingerClosedSockets: linger,
    });

    assert.equal(await pauseIdleSandbox(host, T0 + 600_000), true);
    assert.equal(host.ctx.getWebSockets("sandbox").length, linger ? 1 : 0);
    assert.equal(liveSandboxSockets(host.ctx).length, 0);
    assert.equal(sandboxSocketAttached(host), false);

    handleAgentRequest(host, "wake up", actor, false);
    assert.equal(host.meta.queued_runs.length, 1);
    assert.equal(resumeRequests.count, 1);
    drainQueuedAgentWorkIfReady(host);
    assert.deepEqual(sandboxMessages, []);

    await resumeSandbox(host);
    // The lingering socket must not suppress the reconnect grace.
    assert.ok(host.meta.sandbox_disconnected_at);
    // The agent's reconnect is judged by live sockets only, so it is accepted in resume mode.
    assert.equal(
      sandboxConnectionMode(host.meta.state, host.meta.sandbox_disconnected_at, liveSandboxSockets(host.ctx).length),
      "resume",
    );
    assert.equal(
      sandboxConnectionMode(host.meta.state, undefined, liveSandboxSockets(host.ctx).length),
      "resume",
    );
    drainQueuedAgentWorkIfReady(host);
    assert.deepEqual(sandboxMessages, []);

    sandboxSockets.push(createFakeSandboxSocket());
    drainQueuedAgentWorkIfReady(host);
    drainQueuedAgentWorkIfReady(host);
    assert.deepEqual(sandboxMessages.map((message) => message.type), ["agent_turn"]);
    assert.equal(host.meta.queued_runs.length, 0);
    assert.ok(host.meta.active_run);
  });
}

// --- the paused VM is never woken by a plain handle lookup ---

test("a handle lookup on a paused session returns null without connecting", async () => {
  let connects = 0;
  const provider = createFakeSandboxProvider({ name: "e2b", connect: async () => { connects += 1; return {}; } });
  const meta = { session_id: "ses_test", sandbox_ref: { provider: "e2b", id: "sbx_1" } };
  const paused = await connectSandboxHandle({
    meta: { ...meta, sandbox_paused_at: "2026-10-01T00:10:00.000Z" },
    provider,
    readSecret: async () => undefined,
  });
  assert.equal(paused, null);
  assert.equal(connects, 0);

  await connectSandboxHandle({ meta, provider, readSecret: async () => undefined });
  assert.equal(connects, 1);
});

test("logs and diagnostics of a paused sandbox answer paused without waking the VM", async () => {
  const resolve = async () => assert.fail("must not resolve the sandbox");
  for (const respond of [sandboxLogsResponse, sandboxDiagnosticsResponse]) {
    const response = await respond(resolve, [], { paused: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).paused, true);
  }
});

// --- teardown races ---

test("stop during an in-flight pause waits for it and then destroys the sandbox", async () => {
  const { host, handle } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  let release;
  handle.pause = () => new Promise((resolve) => { release = resolve; handle.calls.push(["pause"]); });

  const pausing = pauseIdleSandbox(host, T0 + 600_000);
  await new Promise((resolve) => setImmediate(resolve));
  host.transition("failed");
  const terminating = terminateSandbox(host, "stopped by user");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!callNames(handle).includes("destroy"), "destroy must wait for the pause to settle");

  release();
  assert.equal(await pausing, false);
  await terminating;
  assert.deepEqual(callNames(handle), ["pause", "destroy"]);
  assert.equal(host.meta.sandbox_paused_at, undefined);
});

// --- failed pause recovery ---

test("a failed pause releases a run that queued during it and re-arms the alarm", async () => {
  const fake = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  const { host, handle, sandboxMessages } = fake;
  let fail;
  handle.pause = () => new Promise((_, reject) => { fail = reject; });

  const pausing = pauseIdleSandbox(host, T0 + 600_000);
  await new Promise((resolve) => setImmediate(resolve));
  handleAgentRequest(host, "queued mid-pause", actor, false);
  assert.equal(host.meta.queued_runs.length, 1);
  assert.deepEqual(sandboxMessages, []);
  const armsBefore = fake.armCalls;

  fail(new Error("pause rejected"));
  assert.equal(await pausing, false);

  assert.equal(host.meta.expected_close, false);
  assert.equal(host.meta.queued_runs.length, 0);
  assert.deepEqual(sandboxMessages.map((message) => message.type), ["agent_turn"]);
  assert.ok(fake.armCalls > armsBefore);
});

test("a failed pause with no live socket left starts the reconnect grace", async () => {
  const fake = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  const { host, handle, sandboxSockets, broadcasts } = fake;
  // The agent dropped while expected_close was set, so the drop was ignored.
  handle.pause = async () => {
    sandboxSockets.length = 0;
    throw new Error("pause rejected");
  };
  const armsBefore = fake.armCalls;

  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), false);

  assert.equal(host.meta.expected_close, false);
  assert.ok(host.meta.sandbox_disconnected_at);
  assert.ok(broadcasts.some((event) => event.type === "status" && /interrupted/.test(event.message)));
  assert.ok(fake.armCalls > armsBefore);
});

test("a failed pause with a live socket does not start the reconnect grace", async () => {
  const { host } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true, pauseError: new Error("boom") });
  await pauseIdleSandbox(host, T0 + 600_000);
  assert.equal(host.meta.sandbox_disconnected_at, undefined);
});

// --- preview_start / preview_stop while paused ---

test("preview_start on a paused session resumes, defers, and sends once the agent reconnects", async () => {
  const { host, resumeRequests, activity, broadcasts, sandboxMessages, sandboxSockets } = createFakeHost(pausedMeta, {
    e2b: true,
    sandboxConnected: false,
  });

  await handlePreviewStart(host, "web");

  assert.equal(resumeRequests.count, 1);
  assert.equal(activity.count, 1);
  assert.deepEqual(host.meta.pending_preview_action, { type: "start", app_key: "web" });
  assert.deepEqual(sandboxMessages, []);
  assert.ok(broadcasts.some((event) => event.type === "status" && event.message === "Sandbox is resuming; the preview will start when it reconnects."));
  assert.ok(!broadcasts.some((event) => event.type === "error"));

  await resumeSandbox(host);
  // Resumed, but the agent has not reconnected yet.
  assert.equal(flushPendingPreviewAction(host), false);
  sandboxSockets.push(createFakeSandboxSocket());
  assert.equal(flushPendingPreviewAction(host), true);
  assert.equal(flushPendingPreviewAction(host), false);
  assert.deepEqual(sandboxMessages.map((message) => [message.type, message.app_key]), [["preview_start", "web"]]);
  assert.equal(host.meta.pending_preview_action, undefined);
});

test("preview_start on a running session is sent straight away", async () => {
  const { host, sandboxMessages, resumeRequests } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  await handlePreviewStart(host, "web");
  assert.deepEqual(sandboxMessages.map((message) => message.type), ["preview_start"]);
  assert.equal(resumeRequests.count, 0);
  assert.equal(host.meta.pending_preview_action, undefined);
});

test("preview_start during an in-flight pause is sent after the pause fails", async () => {
  const { host, handle, sandboxMessages } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  let fail;
  handle.pause = () => new Promise((_, reject) => { fail = reject; });

  const pausing = pauseIdleSandbox(host, T0 + 600_000);
  await new Promise((resolve) => setImmediate(resolve));
  await handlePreviewStart(host);
  assert.ok(host.meta.pending_preview_action);
  assert.deepEqual(sandboxMessages, []);

  fail(new Error("pause rejected"));
  await pausing;
  assert.deepEqual(sandboxMessages.map((message) => message.type), ["preview_start"]);
  assert.equal(host.meta.pending_preview_action, undefined);
});

test("preview_stop on a paused session resumes, defers, and is replayed exactly once on reconnect", async () => {
  const { host, resumeRequests, activity, broadcasts, sandboxMessages, sandboxSockets } = createFakeHost(pausedMeta, {
    e2b: true,
    sandboxConnected: false,
  });

  await handlePreviewStop(host);

  assert.equal(resumeRequests.count, 1);
  assert.equal(activity.count, 1);
  assert.deepEqual(host.meta.pending_preview_action, { type: "stop" });
  assert.deepEqual(sandboxMessages, []);
  assert.ok(broadcasts.some((event) => event.type === "status" && event.message === "Sandbox is resuming; the preview will stop when it reconnects."));
  assert.ok(!broadcasts.some((event) => event.type === "error"));

  await resumeSandbox(host);
  assert.equal(flushPendingPreviewAction(host), false);
  sandboxSockets.push(createFakeSandboxSocket());
  assert.equal(flushPendingPreviewAction(host), true);
  assert.equal(flushPendingPreviewAction(host), false);
  assert.deepEqual(sandboxMessages, [{ type: "preview_stop" }]);
  assert.equal(host.meta.pending_preview_action, undefined);
});

test("the latest preview command wins while the sandbox is unavailable", async () => {
  const startThenStop = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: false });
  await handlePreviewStart(startThenStop.host, "web");
  await handlePreviewStop(startThenStop.host);
  assert.deepEqual(startThenStop.host.meta.pending_preview_action, { type: "stop" });
  startThenStop.sandboxSockets.push(createFakeSandboxSocket());
  await resumeSandbox(startThenStop.host);
  assert.deepEqual(startThenStop.sandboxMessages.map((message) => message.type), ["preview_stop"]);

  const stopThenStart = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: false });
  await handlePreviewStop(stopThenStart.host);
  await handlePreviewStart(stopThenStart.host, "web");
  assert.deepEqual(stopThenStart.host.meta.pending_preview_action, { type: "start", app_key: "web" });
  stopThenStart.sandboxSockets.push(createFakeSandboxSocket());
  await resumeSandbox(stopThenStart.host);
  assert.deepEqual(stopThenStart.sandboxMessages.map((message) => [message.type, message.app_key]), [["preview_start", "web"]]);
});

test("a preview command that reaches a live agent supersedes a stale deferred one", async () => {
  const { host, sandboxMessages } = createFakeHost(
    { ...idleMeta, pending_preview_action: { type: "start", app_key: "old" } },
    { e2b: true, sandboxConnected: true },
  );
  await handlePreviewStop(host);
  assert.deepEqual(sandboxMessages, [{ type: "preview_stop" }]);
  assert.equal(host.meta.pending_preview_action, undefined);
});

test("a stale paused marker cleared by the alarm replays a deferred preview stop", async () => {
  const { host, sandboxMessages } = createFakeHost(
    { ...pausedMeta, pending_preview_action: { type: "stop" } },
    { e2b: true, sandboxConnected: true },
  );
  assert.equal(clearStalePausedMarker(host), true);
  assert.deepEqual(sandboxMessages, [{ type: "preview_stop" }]);
});

test("legacy pending_preview_start meta loads as a start action", () => {
  const load = (legacy, extra = {}) => {
    const meta = createDefaultMeta({ pending_preview_start: legacy, ...extra });
    const store = { meta: null, eventLog: { hydrateFromSql() {} } };
    loadSessionMeta({ exec: () => [{ value: JSON.stringify(meta) }] }, store);
    return store.meta;
  };

  const flag = load(true);
  assert.deepEqual(flag.pending_preview_action, { type: "start" });
  assert.equal(flag.pending_preview_start, undefined);

  assert.deepEqual(load({ app_key: "web" }).pending_preview_action, { type: "start", app_key: "web" });
  // An explicit action is never overwritten by the legacy flag.
  assert.deepEqual(load(true, { pending_preview_action: { type: "stop" } }).pending_preview_action, { type: "stop" });
});

test("a deferred preview start is dropped when the session fails", async () => {
  const { host } = createFakeHost(pausedMeta, { e2b: true, sandboxConnected: false, connectError: new SandboxNotFoundError() });
  await handlePreviewStart(host, "web");
  await resumeSandbox(host);
  assert.equal(host.meta.state, "failed");
  assert.equal(host.meta.pending_preview_action, undefined);
});

// --- activity ---

test("recordSessionActivity throttles only the write, never the alarm re-arm", () => {
  const fake = createFakeHost(
    { ...idleMeta, last_activity_at: "2026-10-01T00:00:00.000Z" },
    { e2b: true, sandboxConnected: true },
  );
  const { host } = fake;

  recordSessionActivity(host, T0 + 5_000);
  assert.equal(host.meta.last_activity_at, new Date(T0 + 5_000).toISOString());
  const writes = fake.saveMetaCalls;
  const arms = fake.armCalls;

  // Within the throttle window: no write, but the idle alarm is still re-armed.
  recordSessionActivity(host, T0 + 5_400);
  assert.equal(host.meta.last_activity_at, new Date(T0 + 5_000).toISOString());
  assert.equal(fake.saveMetaCalls, writes);
  assert.equal(fake.armCalls, arms + 1);
});

test("recordSessionActivity does not re-arm when no idle deadline applies", () => {
  const fake = createFakeHost(
    { ...idleMeta, active_run: { id: "run_1", state: "thinking" } },
    { e2b: true, sandboxConnected: true },
  );
  recordSessionActivity(fake.host, T0 + 5_000);
  assert.equal(fake.armCalls, 0);
});

test("recordSessionActivity leaves a Cloudflare session untouched", () => {
  const fake = createFakeHost(
    { state: "ready", last_activity_at: "2026-10-01T00:00:00.000Z" },
    { sandboxConnected: true },
  );
  recordSessionActivity(fake.host, T0 + 60_000);
  assert.equal(fake.host.meta.last_activity_at, "2026-10-01T00:00:00.000Z");
  assert.equal(fake.saveMetaCalls, 0);
  assert.equal(fake.armCalls, 0);
});

test("an open question blocks the pause", () => {
  const sql = createFakeSql({ questions: [{ request_id: "q1", run_id: "run_1", status: "open" }] });
  const withRun = createFakeHost(
    { ...idleMeta, active_run: { id: "run_1", state: "thinking" } },
    { e2b: true, sandboxConnected: true, sql },
  );
  assert.equal(idlePauseInput(withRun.host, T0 + 3_600_000).openQuestions, 1);

  // Questions only exist for a run; with no active run nothing counts.
  const noRun = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true, sql });
  assert.equal(idlePauseInput(noRun.host, T0 + 3_600_000).openQuestions, 0);
});

// --- lease renewal is its own capability ---

test("lease renewal follows the leaseRenewal capability, not pauseResume", async () => {
  const withCapabilities = (capabilities) => {
    const fake = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
    const provider = fake.provider;
    fake.host.sandboxProvider = () => ({ ...provider, capabilities: { workspaceCache: false, ...capabilities } });
    return fake;
  };

  const pauseOnly = withCapabilities({ pauseResume: true, leaseRenewal: false });
  await renewSandboxLeaseIfDue(pauseOnly.host, T0 + 60 * 60_000);
  assert.equal(pauseOnly.handle.calls.length, 0);
  assert.equal(pauseOnly.host.meta.sandbox_lease_renewed_at, undefined);
  assert.equal(sandboxAlarmDeadlines(pauseOnly.host).leaseRenewAt, null);
  assert.equal(sandboxAlarmDeadlines(pauseOnly.host).idlePauseAt, T0 + 600_000);

  const leaseOnly = withCapabilities({ pauseResume: false, leaseRenewal: true });
  await renewSandboxLeaseIfDue(leaseOnly.host, T0 + 5 * 60_000);
  assert.deepEqual(callNames(leaseOnly.handle), ["renewLease"]);
  assert.equal(sandboxAlarmDeadlines(leaseOnly.host).idlePauseAt, null);
});

// --- follow-ups: resume/reconnect interleaving, reconnect window, closing flag, preview bursts ---

test("an agent that reconnects mid-resume still gets the deferred preview start and queued run", async () => {
  const { host, provider, handle, sandboxSockets, sandboxMessages } = createFakeHost(
    { ...pausedMeta, queued_runs: [queuedRun()] },
    { e2b: true, sandboxConnected: false },
  );
  let release;
  provider.connect = () => new Promise((resolve) => { release = () => resolve(handle); });
  await handlePreviewStart(host, "web");
  const resuming = resumeSandbox(host);
  await new Promise((resolve) => setImmediate(resolve));

  // connect woke the VM; the agent reconnects with its old token before completeResume runs.
  // The accept path drains and flushes, but the paused marker is still set.
  sandboxSockets.push(createFakeSandboxSocket());
  assert.equal(flushPendingPreviewAction(host), false);

  release();
  await resuming;

  assert.equal(host.meta.pending_preview_action, undefined);
  assert.deepEqual(sandboxMessages.map((message) => message.type).sort(), ["agent_turn", "preview_start"]);
  // A later stop is a real stop, not swallowed as a cancelled deferred start.
  await handlePreviewStop(host);
  assert.ok(sandboxMessages.some((message) => message.type === "preview_stop"));
});

test("preview_start in the reconnect window after a resume is deferred until the agent returns", async () => {
  const { host, sandboxMessages, sandboxSockets, broadcasts, resumeRequests } = createFakeHost(
    { ...idleMeta, sandbox_disconnected_at: "2026-10-01T00:10:01.000Z" },
    { e2b: true, sandboxConnected: false },
  );

  await handlePreviewStart(host, "web");

  assert.deepEqual(host.meta.pending_preview_action, { type: "start", app_key: "web" });
  assert.deepEqual(sandboxMessages, []);
  assert.equal(resumeRequests.count, 1);
  assert.ok(broadcasts.some((event) => event.type === "status" && event.message === "Sandbox is reconnecting; the preview will start when it reconnects."));
  assert.ok(!broadcasts.some((event) => event.type === "error"));

  sandboxSockets.push(createFakeSandboxSocket());
  host.meta.sandbox_disconnected_at = undefined; // completeSandboxReconnect
  assert.equal(flushPendingPreviewAction(host), true);
  assert.deepEqual(sandboxMessages.map((message) => message.type), ["preview_start"]);
});

test("preview_stop in the reconnect window is deferred and replayed once the agent returns", async () => {
  const { host, sandboxMessages, broadcasts, sandboxSockets } = createFakeHost(
    { ...idleMeta, sandbox_disconnected_at: "2026-10-01T00:10:01.000Z" },
    { e2b: true, sandboxConnected: false },
  );
  await handlePreviewStop(host);
  assert.deepEqual(sandboxMessages, []);
  assert.deepEqual(host.meta.pending_preview_action, { type: "stop" });
  assert.ok(broadcasts.some((event) => event.type === "status" && event.message === "Sandbox is reconnecting; the preview will stop when it reconnects."));
  assert.ok(!broadcasts.some((event) => event.type === "error"));

  sandboxSockets.push(createFakeSandboxSocket());
  host.meta.sandbox_disconnected_at = undefined; // completeSandboxReconnect
  assert.equal(flushPendingPreviewAction(host), true);
  assert.deepEqual(sandboxMessages, [{ type: "preview_stop" }]);
});

test("preview_start is not deferred when the agent is attached, or for a provider that cannot pause", async () => {
  const attached = createFakeHost(
    { ...idleMeta, sandbox_disconnected_at: "2026-10-01T00:10:01.000Z" },
    { e2b: true, sandboxConnected: true },
  );
  await handlePreviewStart(attached.host, "web");
  assert.deepEqual(attached.sandboxMessages.map((message) => message.type), ["preview_start"]);

  // Cloudflare behavior is unchanged: the command goes straight to sendToSandbox.
  const cloudflare = createFakeHost(
    { state: "ready", sandbox_disconnected_at: "2026-10-01T00:10:01.000Z" },
    { sandboxConnected: false },
  );
  await handlePreviewStart(cloudflare.host, "web");
  await handlePreviewStop(cloudflare.host);
  assert.deepEqual(cloudflare.sandboxMessages.map((message) => message.type), ["preview_start", "preview_stop"]);
  assert.equal(cloudflare.host.meta.pending_preview_action, undefined);
  assert.equal(cloudflare.resumeRequests.count, 0);
  assert.equal(cloudflare.activity.count, 0);
});

test("a close of a socket the DO closed on purpose is never an interruption, even after expected_close reset", () => {
  const closedByDo = createFakeSandboxSocket();
  closeSandboxSockets({ getWebSockets: () => [closedByDo] }, "sandbox paused");
  assert.equal(
    isUnexpectedSandboxDisconnect({ expectedClose: false, state: "ready", closedSocket: closedByDo, sandboxSockets: [closedByDo] }),
    false,
  );
  // The agent's own socket dropping is still an interruption.
  const dropped = createFakeSandboxSocket();
  assert.equal(
    isUnexpectedSandboxDisconnect({ expectedClose: false, state: "ready", closedSocket: dropped, sandboxSockets: [dropped] }),
    true,
  );
});

test("bursts of preview traffic re-arm the idle alarm only when the idle deadline moved", () => {
  const fake = createFakeHost(
    { ...idleMeta, last_activity_at: "2026-10-01T00:00:00.000Z" },
    { e2b: true, sandboxConnected: true },
  );
  const { host } = fake;

  recordSessionActivity(host, T0 + 5_000, "preview");
  assert.equal(fake.armCalls, 1);
  for (const offset of [5_100, 5_300, 5_900]) recordSessionActivity(host, T0 + offset, "preview");
  assert.equal(fake.armCalls, 1, "requests inside the throttle window do not re-arm");

  recordSessionActivity(host, T0 + 6_100, "preview");
  assert.equal(fake.armCalls, 2, "a request that moves the idle deadline re-arms");

  // A discrete event can change idle eligibility, so it re-arms even inside the window.
  recordSessionActivity(host, T0 + 6_200, "event");
  assert.equal(fake.armCalls, 3);
});

test("authenticated preview requests in a burst do not re-arm the alarm each time", async () => {
  const fake = await previewHost({ sandbox_paused_at: undefined, expected_close: false, last_activity_at: "2026-10-01T00:00:00.000Z" }, { sandboxConnected: true });
  for (let i = 0; i < 5; i += 1) assert.equal((await proxy(fake, PREVIEW_TOKEN)).status, 200);
  assert.equal(fake.activity.count, 5);
  assert.equal(fake.armCalls, 1);
});
