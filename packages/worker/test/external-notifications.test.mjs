import assert from "node:assert/strict";
import test from "node:test";

import { externalNotificationIntent } from "../dist/integrations/notification-intents.js";

test("externalNotificationIntent maps curated Agent Run milestones", () => {
  assert.deepEqual(externalNotificationIntent({
    type: "agent_run_started",
    run_id: "run_1",
    actor: { id: "U1", name: "Ada" },
    text: "Fix auth",
  }), { type: "run_started", runId: "run_1" });

  assert.deepEqual(externalNotificationIntent({
    type: "approval_requested",
    run_id: "run_1",
    plan: "Plan",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0 },
    refinement_round: 0,
  }), { type: "approval_requested", runId: "run_1" });

  assert.deepEqual(externalNotificationIntent({
    type: "question_raised",
    request_id: "question_1",
    run_id: "run_1",
    question: "Which database?",
    allow_freeform: true,
    allow_multiple: false,
    answerable_by: "anyone",
    status: "open",
    raised_at: "2026-07-12T00:00:00.000Z",
  }), { type: "question_asked", runId: "run_1", question: "Which database?" });

  assert.deepEqual(externalNotificationIntent({
    type: "agent_run_completed",
    run_id: "run_1",
    pr_url: "https://github.com/acme/app/pull/7",
  }), {
    type: "run_completed",
    runId: "run_1",
    pullRequestUrl: "https://github.com/acme/app/pull/7",
  });

  assert.deepEqual(externalNotificationIntent({
    type: "agent_run_failed",
    run_id: "run_1",
    message: "Tests failed",
  }), { type: "run_failed", runId: "run_1", message: "Tests failed" });
});

test("externalNotificationIntent ignores noisy events", () => {
  for (const event of [
    { type: "status", message: "Cloning" },
    { type: "clone_progress", line: "Receiving objects" },
    { type: "agent_event", event: { type: "tool_execution_start" } },
    { type: "agent_response", run_id: "run_1", text: "Done" },
  ]) {
    assert.equal(externalNotificationIntent(event), null);
  }
});
