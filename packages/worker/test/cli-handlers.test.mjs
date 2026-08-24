import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRun } from "../dist/agent-runs.js";
import {
  handleAbort,
  handleAgentRequest,
  handleApprove,
  handleQuestionAnswer,
  handleRefine,
} from "../dist/orchestrator/cli-handlers.js";
import { actor, createFakeHost } from "./helpers/fake-host.mjs";

test("handleAgentRequest ignores empty and whitespace-only text", () => {
  const { host, broadcasts } = createFakeHost();

  handleAgentRequest(host, "", actor, false);
  handleAgentRequest(host, "   \t\n", actor, false);

  assert.equal(broadcasts.length, 0);
  assert.equal(host.meta.active_run, undefined);
});

test("handleAgentRequest starts a run immediately when session is ready and idle", () => {
  const { host, broadcasts, sandboxMessages } = createFakeHost({ state: "ready" });

  handleAgentRequest(host, "fix the bug", actor, false);

  assert.ok(broadcasts.some((e) => e.type === "agent_request"));
  assert.ok(broadcasts.some((e) => e.type === "agent_run_started"));
  assert.equal(host.meta.state, "executing");
  assert.equal(host.meta.active_run?.state, "executing");
  assert.equal(sandboxMessages.length, 1);
  assert.equal(sandboxMessages[0].type, "agent_turn");
  assert.equal(sandboxMessages[0].prompt, "fix the bug");
  assert.ok(!broadcasts.some((e) => e.type === "agent_request_queued"));
});

test("handleAgentRequest can separate visible request text from the agent prompt", () => {
  const { host, broadcasts, sandboxMessages } = createFakeHost({ state: "ready" });

  handleAgentRequest(
    host,
    "Source: Slack thread\n\nThread context:\nInternal context\n\nExplicit request:\nFix auth",
    actor,
    false,
    "Fix auth",
  );

  assert.equal(broadcasts.find((event) => event.type === "agent_request").text, "Fix auth");
  assert.match(host.meta.active_run.text, /Thread context:\nInternal context/);
  assert.match(sandboxMessages[0].prompt, /Thread context:\nInternal context/);
});

test("handleAgentRequest queues when another run is already active", () => {
  const active = createAgentRun({
    actor,
    text: "first task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_active",
  });
  active.state = "executing";

  const { host, broadcasts } = createFakeHost({
    state: "executing",
    active_run: active,
  });

  handleAgentRequest(host, "second task", actor, false);

  const queued = broadcasts.find((e) => e.type === "agent_request_queued");
  assert.ok(queued);
  assert.equal(queued.position, 1);
  assert.equal(host.meta.active_run?.id, "run_active");
  assert.equal(host.meta.queued_runs.length, 1);
  assert.equal(host.meta.queued_runs[0].text, "second task");
  assert.ok(!broadcasts.some((e) => e.type === "agent_run_started"));
});

test("handleAgentRequest queues when idle but session is not ready", () => {
  const { host, broadcasts } = createFakeHost({ state: "cloning_repo" });

  handleAgentRequest(host, "early request", actor, false);

  const queued = broadcasts.find((e) => e.type === "agent_request_queued");
  assert.ok(queued);
  assert.equal(queued.position, 1);
  assert.equal(host.meta.active_run, null);
  assert.equal(host.meta.queued_runs.length, 1);
  assert.ok(!broadcasts.some((e) => e.type === "agent_run_started"));
});

test("handleAgentRequest starts immediately while the initial workspace cache job is pending", () => {
  const cacheJob = { status: "running", attempts: 1, next_attempt_at: null };
  const sql = {
    exec(query) {
      if (query.includes("SELECT * FROM workspace_cache_jobs")) {
        return { toArray: () => [cacheJob] };
      }
      return [];
    },
  };
  const { host, broadcasts } = createFakeHost({ state: "ready" }, { sql });

  handleAgentRequest(host, "start without waiting for the snapshot", actor, false);

  assert.equal(host.meta.active_run?.state, "executing");
  assert.equal(host.meta.queued_runs.length, 0);
  assert.ok(broadcasts.some((e) => e.type === "agent_run_started"));
});

test("handleAgentRequest drains an older queued run before enqueueing a new request once ready", () => {
  const olderRun = createAgentRun({
    actor,
    text: "older queued task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_older",
  });
  const cacheJob = { status: "interrupted", attempts: 1, next_attempt_at: null };
  const sql = {
    exec(query) {
      if (query.includes("SELECT * FROM workspace_cache_jobs")) {
        return { toArray: () => [cacheJob] };
      }
      return [];
    },
  };
  const { host, broadcasts, sandboxMessages } = createFakeHost(
    { state: "ready", active_run: null, queued_runs: [olderRun] },
    { sql },
  );

  handleAgentRequest(host, "newer task", actor, false);

  assert.equal(host.meta.active_run?.id, "run_older");
  assert.equal(host.meta.active_run?.state, "executing");
  assert.deepEqual(host.meta.queued_runs.map((run) => run.text), ["newer task"]);
  assert.equal(sandboxMessages.length, 1);
  assert.equal(sandboxMessages[0].prompt, "older queued task");
  assert.equal(broadcasts.find((event) => event.type === "agent_request_queued")?.position, 1);
});

test("handleAgentRequest queues a ready request while the sandbox is disconnected", () => {
  const { host, broadcasts } = createFakeHost(
    { state: "ready" },
    { sandboxConnected: false },
  );

  handleAgentRequest(host, "wait for sandbox reconnect", actor, false);

  assert.equal(host.meta.active_run, null);
  assert.equal(host.meta.queued_runs.length, 1);
  assert.ok(broadcasts.some((event) => event.type === "agent_request_queued"));
  assert.ok(!broadcasts.some((event) => event.type === "agent_run_started"));
});

test("handleAgentRequest does not drain queued work while the sandbox is disconnected", () => {
  const olderRun = createAgentRun({
    actor,
    text: "older queued task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_older_disconnected",
  });
  const cacheJob = { status: "interrupted", attempts: 1, next_attempt_at: null };
  const sql = {
    exec(query) {
      if (query.includes("SELECT * FROM workspace_cache_jobs")) {
        return { toArray: () => [cacheJob] };
      }
      return [];
    },
  };
  const { host, broadcasts } = createFakeHost(
    { state: "ready", active_run: null, queued_runs: [olderRun] },
    { sql, sandboxConnected: false },
  );

  handleAgentRequest(host, "newer task", actor, false);

  assert.equal(host.meta.active_run, null);
  assert.deepEqual(host.meta.queued_runs.map((run) => run.text), [
    "older queued task",
    "newer task",
  ]);
  assert.equal(broadcasts.filter((event) => event.type === "agent_request_queued").length, 1);
  assert.ok(!broadcasts.some((event) => event.type === "agent_run_started"));
});

test("handleAbort cancels an active run and returns session to ready", () => {
  const active = createAgentRun({
    actor,
    text: "long task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_abort",
  });
  active.state = "executing";

  const { host, broadcasts, transitions } = createFakeHost({
    state: "executing",
    active_run: active,
  });

  handleAbort(host, actor.name, "run_abort");

  assert.equal(host.meta.state, "ready");
  assert.deepEqual(transitions.at(-1), { from: "executing", to: "ready" });
  assert.ok(broadcasts.some((e) => e.type === "status" && /cancelled/i.test(e.message)));
  const failed = broadcasts.find((e) => e.type === "agent_run_failed");
  assert.ok(failed);
  assert.equal(failed.run_id, "run_abort");
  assert.equal(failed.message, "Agent run cancelled.");
});

test("handleAbort rejects when session is already terminal", () => {
  const active = createAgentRun({
    actor,
    text: "done",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_done",
  });
  active.state = "completed";

  const { host, broadcasts, transitions } = createFakeHost({
    state: "failed",
    active_run: active,
  });

  handleAbort(host, actor.name);

  assert.equal(transitions.length, 0);
  assert.ok(
    broadcasts.some(
      (e) => e.type === "error" && e.message.includes("terminal state"),
    ),
  );
});

test("handleApprove rejects when session is not awaiting approval", () => {
  const active = createAgentRun({
    actor,
    text: "plan task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_plan",
  });
  active.state = "thinking";

  const { host, broadcasts, sandboxMessages } = createFakeHost({
    state: "planning",
    active_run: active,
    latest_plan: "# Plan",
  });

  handleApprove(host, actor.name, "run_plan");

  const error = broadcasts.find((e) => e.type === "error");
  assert.ok(error);
  assert.match(error.message, /Cannot approve in state: planning/);
  assert.equal(sandboxMessages.length, 0);
  assert.equal(host.meta.state, "planning");
});

test("handleApprove transitions to executing and dispatches execute to sandbox", () => {
  const active = createAgentRun({
    actor,
    text: "plan task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_plan",
  });
  active.state = "awaiting_approval";

  const { host, broadcasts, sandboxMessages, transitions } = createFakeHost({
    state: "awaiting_approval",
    active_run: active,
    latest_plan: "# Ship it",
  });

  handleApprove(host, actor.name, "run_plan");

  assert.equal(host.meta.state, "executing");
  assert.deepEqual(transitions.at(-1), { from: "awaiting_approval", to: "executing" });
  assert.ok(broadcasts.some((e) => e.type === "plan_execution_started"));
  assert.equal(sandboxMessages.length, 1);
  assert.equal(sandboxMessages[0].type, "execute");
  assert.equal(sandboxMessages[0].plan, "# Ship it");
});

test("handleRefine rejects when session is not awaiting approval", () => {
  const active = createAgentRun({
    actor,
    text: "plan task",
    now: "2026-06-03T00:00:00.000Z",
    id: "run_plan",
  });
  active.state = "executing";

  const { host, broadcasts, sandboxMessages } = createFakeHost({
    state: "executing",
    active_run: active,
  });

  handleRefine(host, "tweak the plan", actor.name, "run_plan");

  const error = broadcasts.find((e) => e.type === "error");
  assert.ok(error);
  assert.match(error.message, /Cannot refine in state: executing/);
  assert.equal(sandboxMessages.length, 0);
});

test("handleQuestionAnswer keeps web authorization before the shared mutation", () => {
  const row = questionRow();
  const { host, broadcasts, sandboxMessages } = questionHost(row);

  handleQuestionAnswer(
    host,
    { type: "question_answer", request_id: "question_1", option_ids: ["pg"] },
    { id: "member", name: "Member" },
    "member",
    "member",
  );

  assert.equal(row.status, "open");
  assert.equal(sandboxMessages.length, 0);
  assert.match(broadcasts[0].message, /session creator/);
});

function questionRow() {
  return {
    request_id: "question_1",
    run_id: "run_1",
    question: "Which database?",
    status: "open",
    options_json: JSON.stringify([{ id: "pg", label: "PostgreSQL" }]),
    allow_freeform: 0,
    allow_multiple: 0,
    answer_json: null,
    answered_by_id: null,
    answered_by_name: null,
    answered_at: null,
    answerable_by: "decider",
    assigned_to_id: null,
    assigned_to_name: null,
  };
}

function questionHost(row) {
  const broadcasts = [];
  const sandboxMessages = [];
  return {
    broadcasts,
    sandboxMessages,
    host: {
      meta: { created_by: { id: "creator", name: "Creator" } },
      sql: {
        exec(sql, ...bindings) {
          if (sql.includes("SELECT") && sql.includes("FROM questions")) {
            return row.request_id === bindings[0] ? [{ ...row }] : [];
          }
          return [];
        },
      },
      appendAndBroadcast(event) { broadcasts.push(event); },
      sendToSandbox(message) { sandboxMessages.push(message); },
    },
  };
}
