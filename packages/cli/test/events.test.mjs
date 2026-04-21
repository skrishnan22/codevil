import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvelope, renderEvent } from "../dist/events.js";

test("parses cursor envelope and renders plan markdown", () => {
  const envelope = parseEnvelope(JSON.stringify({
    cursor: 7,
    event: {
      type: "plan_ready",
      plan: "## Plan\n\n1. Test",
      cost: {
        input_tokens: 10,
        output_tokens: 20,
        total_cost_usd: 0.03,
      },
      refinement_round: 1,
    },
  }));

  assert.equal(envelope.cursor, 7);
  assert.equal(envelope.event.type, "plan_ready");
  assert.deepEqual(renderEvent(envelope.event), [
    "",
    "## Plan",
    "",
    "1. Test",
    "",
    "Cost: $0.03 (10 input tokens, 20 output tokens)",
    "Refinement round: 1",
    "",
  ]);
});

test("renders complete event with PR URL", () => {
  assert.deepEqual(renderEvent({
    type: "complete",
    pr_url: "https://github.com/example/app/pull/1",
  }), [
    "Completed. Draft PR: https://github.com/example/app/pull/1",
  ]);
});

test("rejects malformed envelopes", () => {
  assert.throws(
    () => parseEnvelope(JSON.stringify({ cursor: "7", event: { type: "status", message: "x" } })),
    /Invalid event envelope/,
  );
});
