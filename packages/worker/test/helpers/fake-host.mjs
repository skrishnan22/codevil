import { isValidTransition } from "../../../shared/dist/index.js";
import { createAgentRun } from "../../dist/agent-runs.js";

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

export function createFakeTracer() {
  return {
    trace_id: "trace_test",
    span: async (_name, _opts, fn) => fn(),
    log: () => {},
  };
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

  const host = {
    meta,
    sql: options.sql ?? createFakeSql(),
    workerEnv: options.workerEnv ?? {
      CODEVIL_API_KEY: "test-key",
      Sandbox: {},
      DB: {},
    },
    ctx: {
      waitUntil(promise) {
        backgroundWork.push(Promise.resolve(promise).catch(() => {}));
      },
      getWebSockets(tag) {
        if (tag !== "sandbox") return [];
        return options.sandboxConnected === false ? [] : [{}];
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
    armNextAlarm: async () => {},
  };

  return {
    host,
    actor: options.actor ?? actor,
    broadcasts,
    transitions,
    sandboxMessages,
    directoryPatches,
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
