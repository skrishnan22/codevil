/**
 * Tests for the buildReplayBatch pure helper (Task 6).
 *
 * The Orchestrator class cannot be instantiated in Node.js because its base
 * class (DurableObject) is provided by the `cloudflare:workers` runtime.
 * The pure helper `buildReplayBatch` is exported from orchestrator.ts and
 * imported here so these tests exercise the real production function.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildReplayBatch } from "../dist/replay-batch.js";

test("replay-batch: empty rows produces an empty events array", () => {
  const events = buildReplayBatch([]);
  assert.equal(events.length, 0);
});

test("replay-batch: N rows produce N items in order", () => {
  const rows = [
    { id: 1, event_json: JSON.stringify({ type: "session_created", session_id: "ses_1" }) },
    { id: 2, event_json: JSON.stringify({ type: "status", message: "Provisioning..." }) },
    { id: 3, event_json: JSON.stringify({ type: "room_ready", repo: "github.com/acme/app" }) },
  ];

  const events = buildReplayBatch(rows);

  assert.equal(events.length, 3);
  assert.equal(events[0].cursor, 1);
  assert.deepEqual(events[0].event, { type: "session_created", session_id: "ses_1" });
  assert.equal(events[1].cursor, 2);
  assert.equal(events[2].cursor, 3);
});

test("replay-batch: rows with invalid JSON are silently skipped", () => {
  const rows = [
    { id: 1, event_json: JSON.stringify({ type: "session_created", session_id: "ses_1" }) },
    { id: 2, event_json: "NOT VALID JSON {{{{" },
    { id: 3, event_json: JSON.stringify({ type: "status", message: "done" }) },
  ];

  const events = buildReplayBatch(rows);

  assert.equal(events.length, 2, "malformed row should be skipped");
  assert.equal(events[0].cursor, 1);
  assert.equal(events[1].cursor, 3);
});

test("replay-batch: rows without event type are silently skipped", () => {
  const rows = [
    { id: 1, event_json: JSON.stringify({ type: "session_created", session_id: "ses_1" }) },
    { id: 2, event_json: JSON.stringify({ message: "missing type" }) },
    { id: 3, event_json: JSON.stringify({ type: "status", message: "done" }) },
  ];

  const events = buildReplayBatch(rows);

  assert.equal(events.length, 2, "event without type should be skipped");
  assert.equal(events[0].cursor, 1);
  assert.equal(events[1].cursor, 3);
});

test("replay-batch: result is a JSON-serializable replay_batch frame", () => {
  const rows = [
    { id: 10, event_json: JSON.stringify({ type: "status", message: "Hello" }) },
  ];
  const events = buildReplayBatch(rows);
  const frame = { type: "replay_batch", events };
  const serialized = JSON.parse(JSON.stringify(frame));

  assert.equal(serialized.type, "replay_batch");
  assert.equal(serialized.events.length, 1);
  assert.equal(serialized.events[0].cursor, 10);
  assert.deepEqual(serialized.events[0].event, { type: "status", message: "Hello" });
});
