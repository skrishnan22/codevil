import assert from "node:assert/strict";
import test from "node:test";

import {
  capEventForStorage,
  eventJsonByteLength,
  MAX_EVENT_JSON_BYTES,
} from "../dist/orchestrator/event-log-limits.js";

test("capEventForStorage leaves small events unchanged", () => {
  const event = { type: "status", message: "hello" };
  const result = capEventForStorage(event);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.event, event);
});

test("capEventForStorage truncates oversized string fields", () => {
  const event = {
    type: "agent_event",
    event: {
      type: "tool_execution_end",
      output: "x".repeat(MAX_EVENT_JSON_BYTES),
    },
  };

  const result = capEventForStorage(event);
  const json = JSON.stringify(result.event);
  assert.ok(eventJsonByteLength(json) <= MAX_EVENT_JSON_BYTES);
  assert.equal(result.truncated, true);
});

test("capEventForStorage eventually fits within byte limit for huge payloads", () => {
  const event = {
    type: "agent_event",
    event: {
      a: "x".repeat(MAX_EVENT_JSON_BYTES),
      b: "y".repeat(MAX_EVENT_JSON_BYTES),
      c: "z".repeat(MAX_EVENT_JSON_BYTES),
    },
  };

  const result = capEventForStorage(event);
  assert.ok(eventJsonByteLength(JSON.stringify(result.event)) <= MAX_EVENT_JSON_BYTES);
  assert.equal(result.truncated, true);
});
