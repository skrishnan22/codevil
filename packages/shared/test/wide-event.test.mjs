import assert from "node:assert/strict";
import test from "node:test";

import {
  WideEventBuilder,
  assembleWideEvent,
  partitionWideEventAttributes,
} from "../dist/wide-event.js";

test("assembleWideEvent merges domain groups at the top level", () => {
  const event = assembleWideEvent({
    record_type: "span",
    trace_id: "abc",
    span_id: "def",
    session_id: "ses_1",
    service: "orchestrator",
    operation: "phase.plan",
    duration_ms: 1200,
    outcome: "success",
    groups: {
      session: { repo: "github.com/acme/app", state: "planning" },
    },
    flat: { state_from: "cloning_repo" },
  });

  assert.equal(event.kind, "wide_event");
  assert.equal(event.record_type, "span");
  assert.equal(event.operation, "phase.plan");
  assert.equal(event.session?.repo, "github.com/acme/app");
  assert.equal(event.state_from, "cloning_repo");
});

test("partitionWideEventAttributes promotes known groups", () => {
  const { groups, flat } = partitionWideEventAttributes({
    session_id: "ses_1",
    session: { state: "executing" },
    attempt: 2,
  });

  assert.equal(flat.session_id, "ses_1");
  assert.equal(flat.attempt, 2);
  assert.equal(groups.session?.state, "executing");
});

test("WideEventBuilder accumulates groups and flat fields", () => {
  const builder = new WideEventBuilder()
    .setGroup("run", { run_id: "run_1" })
    .set("model", "gpt-5");

  assert.deepEqual(builder.groupsSnapshot().run, { run_id: "run_1" });
  assert.equal(builder.flatSnapshot().model, "gpt-5");
});
