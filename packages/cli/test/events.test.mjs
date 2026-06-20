import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvelope, parseFrame, renderEvent } from "../dist/events.js";

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

test("renders newer non-CLI events as no output", () => {
  assert.deepEqual(renderEvent({
    type: "participant_joined",
    participant: { id: "usr_123", name: "Alice" },
  }), []);
});

test("rejects malformed envelopes", () => {
  assert.throws(
    () => parseEnvelope(JSON.stringify({ cursor: "7", event: { type: "status", message: "x" } })),
    /Invalid event envelope/,
  );
});

// --- C1 fix: snapshot and replay_batch frame handling ---

test("parseFrame: snapshot frame returns kind=snapshot with cursor, does not throw", () => {
  const raw = JSON.stringify({
    type: "snapshot",
    path: "session",
    cursor: 42,
    state: { sessionPhase: "executing", messages: [], participants: [] },
  });
  const result = parseFrame(raw);
  assert.equal(result.kind, "snapshot", "snapshot frame must parse as kind=snapshot");
  assert.equal(result.cursor, 42, "cursor must be preserved");
});

test("parseFrame: replay_batch frame returns kind=replay_batch with events, does not throw", () => {
  const raw = JSON.stringify({
    type: "replay_batch",
    events: [
      { cursor: 1, event: { type: "session_created", session_id: "ses_abc" } },
      { cursor: 2, event: { type: "status", message: "Waiting for sandbox." } },
    ],
  });
  const result = parseFrame(raw);
  assert.equal(result.kind, "replay_batch", "replay_batch frame must parse as kind=replay_batch");
  assert.equal(result.events.length, 2, "both events should be present");
  assert.equal(result.events[0].cursor, 1);
  assert.equal(result.events[0].event.type, "session_created");
  assert.equal(result.events[1].cursor, 2);
  assert.equal(result.events[1].event.type, "status");
});

test("parseFrame: snapshot frame followed by replay_batch frame — neither throws", () => {
  // Simulates the sequence the DO sends on cold-start join:
  //   1. snapshot frame
  //   2. replay_batch frame with the tail events
  const snapshotRaw = JSON.stringify({
    type: "snapshot",
    path: "session",
    cursor: 10,
    state: { sessionPhase: "ready" },
  });
  const replayRaw = JSON.stringify({
    type: "replay_batch",
    events: [
      { cursor: 11, event: { type: "status", message: "Repository cloned." } },
    ],
  });

  // Neither call should throw.
  const snapResult = parseFrame(snapshotRaw);
  const replayResult = parseFrame(replayRaw);

  assert.equal(snapResult.kind, "snapshot");
  assert.equal(snapResult.cursor, 10);

  assert.equal(replayResult.kind, "replay_batch");
  assert.equal(replayResult.events.length, 1);
  assert.equal(replayResult.events[0].event.type, "status");
});

test("parseFrame: legacy {cursor,event} envelope returns kind=envelope", () => {
  const raw = JSON.stringify({ cursor: 7, event: { type: "status", message: "ok" } });
  const result = parseFrame(raw);
  assert.equal(result.kind, "envelope");
  assert.equal(result.cursor, 7);
  assert.equal(result.event.type, "status");
});

test("parseEnvelope: returns null for snapshot frame (not an EventEnvelope)", () => {
  const raw = JSON.stringify({
    type: "snapshot",
    path: "session",
    cursor: 5,
    state: {},
  });
  const result = parseEnvelope(raw);
  assert.equal(result, null, "parseEnvelope should return null for snapshot frames");
});

test("parseEnvelope: returns null for replay_batch frame (not an EventEnvelope)", () => {
  const raw = JSON.stringify({
    type: "replay_batch",
    events: [{ cursor: 1, event: { type: "status", message: "x" } }],
  });
  const result = parseEnvelope(raw);
  assert.equal(result, null, "parseEnvelope should return null for replay_batch frames");
});
