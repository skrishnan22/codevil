import { test } from "node:test";
import assert from "node:assert/strict";

import { ConsolidationCompleteSchema } from "../dist/index.js";

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
  assert.equal(parsed.brief_items, undefined);
  assert.equal(parsed.conflicts, undefined);
});

test("consolidation_complete still parses legacy path: {run_id, round, brief_items, cost}", () => {
  const parsed = ConsolidationCompleteSchema.parse({
    type: "consolidation_complete",
    run_id: "run_2",
    round: 1,
    brief_items: [
      { instruction: "Use D1-backed storage.", source_thread_ids: ["ann_1"] },
    ],
    conflicts: [],
    cost: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.001 },
  });
  assert.equal(parsed.run_id, "run_2");
  assert.equal(parsed.brief, undefined);
  assert.equal(parsed.brief_items?.length, 1);
  assert.equal(parsed.brief_items?.[0].instruction, "Use D1-backed storage.");
  assert.deepEqual(parsed.conflicts, []);
});

test("consolidation_complete parses with both brief and brief_items present (forward compat)", () => {
  const parsed = ConsolidationCompleteSchema.parse({
    type: "consolidation_complete",
    run_id: "run_3",
    round: 2,
    brief: "Prose brief text.",
    brief_items: [{ instruction: "Also this.", source_thread_ids: [] }],
    cost: { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
  });
  assert.equal(parsed.brief, "Prose brief text.");
  assert.equal(parsed.brief_items?.length, 1);
});

test("consolidation_complete requires type, run_id, round, cost", () => {
  assert.throws(() => ConsolidationCompleteSchema.parse({
    run_id: "run_1",
    round: 0,
    cost: { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
  }));
});
