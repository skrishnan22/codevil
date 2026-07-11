import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRun } from "../dist/agent-runs.js";
import {
  dispatchSandboxSocketMessage,
  handleSandboxCloneComplete,
  handleSandboxCloneStarted,
  handleSandboxPlanReady,
  provisionSessionSandbox,
} from "../dist/orchestrator/sandbox-handlers.js";
import { actor, createFakeHost, createFakeTracer } from "./helpers/fake-host.mjs";

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
