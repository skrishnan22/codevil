import { test } from "node:test";
import assert from "node:assert/strict";

import { ConsolidationCompleteSchema, DOToSandboxMessageSchema } from "../dist/index.js";

test("consolidation_complete parses new prose path: {run_id, round, brief, cost}", () => {
  const parsed = ConsolidationCompleteSchema.parse({
    type: "consolidation_complete",
    run_id: "run_1",
    round: 0,
    brief: "Use D1-backed storage for user sessions. Avoid Redis.",
    cost: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.001 },
  });
  assert.equal(parsed.run_id, "run_1");
  assert.equal(parsed.round, 0);
  assert.equal(parsed.brief, "Use D1-backed storage for user sessions. Avoid Redis.");
});

test("consolidation_complete requires brief (prose path is the only path)", () => {
  assert.throws(() => ConsolidationCompleteSchema.parse({
    type: "consolidation_complete",
    run_id: "run_2",
    round: 1,
    cost: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.001 },
  }));
});

test("consolidation_complete requires type, run_id, round, cost", () => {
  assert.throws(() => ConsolidationCompleteSchema.parse({
    run_id: "run_1",
    round: 0,
    cost: { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
  }));
});

test("protocol_error round-trips through DOToSandboxMessageSchema", () => {
  const raw = { type: "protocol_error", message: "Invalid message (type: bad)" };
  const parsed = DOToSandboxMessageSchema.parse(raw);
  assert.deepEqual(parsed, raw);
});
