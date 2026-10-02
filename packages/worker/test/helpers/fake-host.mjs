import { isValidTransition } from "../../../shared/dist/index.js";
import { createAgentRun } from "../../dist/agent-runs.js";
import {
  recordSessionActivity,
  terminateSandbox as terminateSandboxForHost,
} from "../../dist/orchestrator/sandbox-session-lifecycle.js";
import { closeSandboxSockets as closeSandboxSocketsOnCtx } from "../../dist/sandbox-connection.js";

const actor = { id: "usr_test", name: "Tester" };

export { actor };

export function createDefaultMeta(overrides = {}) {
  return {
    session_id: "ses_test",
    prompt: "",
    repo: "github.com/acme/app",
    worker_url: "https://worker.example",
    provider: "openai",
    plan_model: "gpt-4",
    exec_model: "gpt-4-mini",
    max_time: "30m",
    state: "ready",
    refinement_round: 0,
    verification_attempts: 0,
    cost_total_usd: 0,
    queued_runs: [],
    created_at: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

export function createFakeSql(initial = {}) {
  const questions = [...(initial.questions ?? [])];

  return {
    exec(query, ...params) {
      if (query.includes("SELECT * FROM workspace_cache_jobs")) {
        return { toArray: () => [] };
      }
      if (query.includes("SELECT request_id FROM questions")) {
        const runId = params[0];
        return questions
          .filter((q) => q.run_id === runId && q.status === "open")
          .map((q) => ({ request_id: q.request_id }));
      }
      if (query.includes("UPDATE questions SET status = 'cancelled'")) {
        const [reason, runId] = params;
        for (const question of questions) {
          if (question.run_id === runId && question.status === "open") {
            question.status = "cancelled";
            question.cancelled_reason = reason;
          }
        }
        return [];
      }
      if (query.includes("INSERT OR REPLACE INTO plan_revisions")) {
        return [];
      }
      if (query.includes("UPDATE annotations")) {
        return [];
      }
      return [];
    },
    questions,
  };
}

/** A Cloudflare-like fake sandbox handle; override any member per test. */
export function createFakeSandboxHandle(overrides = {}) {
  return {
    ref: { provider: "cloudflare", id: "ses_test" },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    writeFile: async () => {},
    startProcess: async () => {},
    readProcessLogs: async () => ({ stdout: "", stderr: "" }),
    fetchPort: async () => new Response("ok"),
    renewLease: async () => {},
    destroy: async () => {},
    workspaceCache: {
      restoreBackup: async () => ({}),
      createBackup: async () => ({ id: "backup_test", dir: "/workspace" }),
    },
    ...overrides,
  };
}

export function createFakeSandboxProvider(overrides = {}) {
  return {
    name: "cloudflare",
    capabilities: { pauseResume: false, workspaceCache: true, leaseRenewal: false },
    create: async () => createFakeSandboxHandle(),
    connect: async () => createFakeSandboxHandle(),
    ...overrides,
  };
}

export function createFakeTracer() {
  return {
    trace_id: "trace_test",
    span: async (_name, _opts, fn) => fn(),
    log: () => {},
  };
}

/**
 * A Durable Object sandbox socket double. `close()` deliberately leaves
 * `readyState` OPEN (the worst case for a socket whose paused peer has not yet
 * answered the close handshake) so only the `closing` attachment marks it dead.
 */
export function createFakeSandboxSocket(attachment = { sandbox: { aud: "sandbox_ws", role: "sandbox" } }) {
  let current = attachment;
  return {
    readyState: 1,
    closeCalls: [],
    serializeAttachment(value) { current = value; },
    deserializeAttachment() { return current; },
    close(code, reason) { this.closeCalls.push([code, reason]); },
  };
}

/** A tracer that records `log` calls so tests can assert on (redacted) log output. */
export function createRecordingTracer() {
  const logs = [];
  return {
    ...createFakeTracer(),
    logs,
    log: (level, name, attributes) => logs.push({ level, name, attributes }),
  };
}

/**
 * An E2B-like handle that records its calls as `[name, ...args]`.
 * `pauseError` makes `pause` reject.
 */
export function createFakeE2BHandle(options = {}) {
  const calls = [];
  return {
    calls,
    ref: { provider: "e2b", id: "sbx_1" },
    secret: options.secret,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    writeFile: async (...args) => { calls.push(["writeFile", ...args]); },
    startProcess: async () => {},
    readProcessLogs: async () => ({ stdout: "", stderr: "" }),
    fetchPort: async () => new Response("ok"),
    renewLease: async (...args) => {
      calls.push(["renewLease", ...args]);
      if (options.renewError) throw options.renewError;
    },
    pause: async () => {
      calls.push(["pause"]);
      if (options.pauseError) throw options.pauseError;
    },
    destroy: async (...args) => { calls.push(["destroy", ...args]); },
  };
}

/** An E2B-like provider whose `connect` counts calls and resolves `handle` (or throws `connectError`). */
export function createFakeE2BProvider(handle, options = {}) {
  const provider = {
    name: "e2b",
    capabilities: { pauseResume: true, workspaceCache: false, leaseRenewal: true },
    connectCalls: 0,
    connectOptions: [],
    create: async () => handle,
    connect: async (_ref, connectOptions) => {
      provider.connectCalls += 1;
      provider.connectOptions.push(connectOptions);
      if (options.connectError) throw options.connectError;
      return handle;
    },
  };
  return provider;
}

export function createFakeHost(metaOverrides = {}, options = {}) {
  const meta = createDefaultMeta(metaOverrides);
  const broadcasts = [];
  const transitions = [];
  const sandboxMessages = [];
  const directoryPatches = [];
  const backgroundWork = [];
  let saveMetaCalls = 0;
  let previewRevoked = false;
  const storage = new Map();
  // `e2b: true` swaps in an E2B-like provider and a call-recording handle.
  const e2bHandle = options.e2b ? createFakeE2BHandle(options) : undefined;
  const e2bProvider = options.e2b ? createFakeE2BProvider(e2bHandle, options) : undefined;
  const sandboxSockets = options.sandboxConnected === false ? [] : [createFakeSandboxSocket()];
  let armCalls = 0;
  const closedSandboxSockets = [];
  const activity = { count: 0 };
  const resumeRequests = { count: 0 };

  const host = {
    meta,
    sql: options.sql ?? createFakeSql(),
    workerEnv: options.workerEnv ?? {
      CODEVIL_API_KEY: "test-key",
      Sandbox: {},
      DB: {},
    },
    ctx: {
      storage: {
        put: async (key, value) => { storage.set(key, value); },
        get: async (key) => storage.get(key),
      },
      waitUntil(promise) {
        backgroundWork.push(Promise.resolve(promise).catch(() => {}));
      },
      getWebSockets(tag) {
        if (tag !== "sandbox") return [];
        return [...sandboxSockets];
      },
    },
    redactionSecrets: [],

    loadMeta() {},
    saveMeta() {
      saveMetaCalls += 1;
    },
    appendAndBroadcast(event) {
      broadcasts.push(event);
    },
    transition(to) {
      const from = meta.state;
      if (!isValidTransition(from, to)) {
        host.appendAndBroadcast({
          type: "error",
          message: `Invalid transition: ${from} → ${to}`,
        });
        return false;
      }
      meta.state = to;
      transitions.push({ from, to });
      host.saveMeta();
      return true;
    },
    sendToSandbox(message) {
      sandboxMessages.push(message);
    },
    trackCost(cost) {
      meta.cost_total_usd += cost.total_cost_usd ?? 0;
    },
    updateDirectory(patch) {
      directoryPatches.push(patch);
    },
    getTracer() {
      return options.tracer ?? null;
    },
    currentPhaseSpan() {
      return undefined;
    },
    freezePlanRevision() {},
    lockPlanRevision() {},
    consumeOpenAnnotations() {},
    ensureAnnotatableRevision() {
      return true;
    },
    ensureActiveRun() {
      return Boolean(meta.active_run);
    },
    setActiveRunState(state) {
      if (!meta.active_run) return;
      meta.active_run = { ...meta.active_run, state };
      host.saveMeta();
      host.updateDirectory({ active_run_state: state });
    },
    startAgentRun() {},
    finishRunAndDrainQueue() {},
    failActiveRunAndReturnReady() {},
    completeActiveRun() {},
    cancelOpenQuestions() {},
    revokePreview() {
      previewRevoked = true;
    },
    recordDecision(decision) {
      meta.last_decision = decision;
      host.saveMeta();
    },
    decisionRejection(_host, _action, fallbackMessage) {
      return { type: "error", message: fallbackMessage };
    },
    armNextAlarm: async () => { armCalls += 1; },
    sandboxProvider() {
      return options.sandboxProvider ?? e2bProvider ?? createFakeSandboxProvider();
    },
    recordActivity() {
      activity.count += 1;
      recordSessionActivity(host);
    },
    requestSandboxResume() {
      resumeRequests.count += 1;
    },
    closeSandboxSockets(reason) {
      closedSandboxSockets.push(reason);
      // `lingerClosedSockets`: closed sockets stay in getWebSockets, marked only by the closing attachment.
      if (options.lingerClosedSockets) closeSandboxSocketsOnCtx(host.ctx, reason);
      else sandboxSockets.length = 0;
    },
    async issueSandboxWebSocketToken() {
      return "fresh_token";
    },
    terminateSandbox(reason) {
      return terminateSandboxForHost(host, reason);
    },
    async sandboxHandle() {
      // Mirrors connectSandboxHandle: a paused sandbox is never woken by a plain handle lookup.
      if (meta.sandbox_paused_at) return null;
      if (options.sandboxHandle !== undefined) return options.sandboxHandle;
      if (e2bHandle) return e2bHandle;
      return createFakeSandboxHandle({
        ref: meta.sandbox_ref ?? { provider: "cloudflare", id: meta.session_id },
      });
    },
  };

  return {
    host,
    actor: options.actor ?? actor,
    broadcasts,
    transitions,
    sandboxMessages,
    directoryPatches,
    storage,
    handle: e2bHandle,
    provider: e2bProvider,
    sandboxSockets,
    closedSandboxSockets,
    activity,
    resumeRequests,
    get armCalls() {
      return armCalls;
    },
    get saveMetaCalls() {
      return saveMetaCalls;
    },
    get previewRevoked() {
      return previewRevoked;
    },
    async drainBackgroundWork() {
      await Promise.allSettled(backgroundWork);
      backgroundWork.length = 0;
    },
    createRun(text, runOverrides = {}) {
      return createAgentRun({
        actor: options.actor ?? actor,
        text,
        now: "2026-06-03T00:00:00.000Z",
        ...runOverrides,
      });
    },
  };
}
