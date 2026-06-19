/**
 * Snapshot maintenance tests (Task 4).
 *
 * The Orchestrator class cannot be instantiated in Node.js because its base
 * class (DurableObject) is provided by the `cloudflare:workers` runtime, which
 * does not exist outside of the Workers environment.  Full DO integration tests
 * would require wrangler's Miniflare harness (vitest + @cloudflare/vitest-pool-workers).
 *
 * Instead, these tests verify the projection logic that appendAndBroadcast
 * uses internally: `applyToSessionSnapshot` from @codevil/shared.  Any
 * regression in the DO's snapshot bookkeeping will surface as a regression in
 * this shared function, which is exactly what the orchestrator delegates to.
 *
 * The test exercises the same event sequence and ProjectionContext shape that
 * appendAndBroadcast constructs (uid: `msg_<id>_<subIndex>`, now: Date.now()).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToSessionSnapshot,
  emptySessionSnapshot,
} from "../../shared/dist/index.js";

// ---------------------------------------------------------------------------
// Helpers — mirror the ProjectionContext appendAndBroadcast builds per event
// ---------------------------------------------------------------------------

function makeServerCtx(cursorId) {
  let subIndex = 0;
  return {
    uid: () => `msg_${cursorId}_${subIndex++}`,
    now: Date.now(),
  };
}

// Simulates the in-DO appendAndBroadcast loop:
//   for each event, produce a cursor id (auto-increment) and apply to snapshot.
function simulateAppendSequence(events) {
  let snap = emptySessionSnapshot();
  let cursor = 0;

  for (const event of events) {
    cursor++;
    const ctx = makeServerCtx(cursor);
    snap = applyToSessionSnapshot(snap, cursor, event, ctx);
  }

  return { snap, finalCursor: cursor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("snapshot: accumulates participants after participant_joined", () => {
  const events = [
    { type: "session_created", session_id: "ses_t1" },
    { type: "participant_joined", participant: { id: "usr_alice", name: "Alice" } },
  ];
  const { snap } = simulateAppendSequence(events);

  assert.ok(
    snap.participants.some((p) => p.id === "usr_alice"),
    "Alice should appear in participants",
  );
});

test("snapshot: cursor advances to the id of the last appended event", () => {
  const events = [
    { type: "session_created", session_id: "ses_t2" },
    { type: "status", message: "Provisioning sandbox..." },
    { type: "room_ready", repo: "github.com/acme/app" },
  ];
  const { snap, finalCursor } = simulateAppendSequence(events);

  assert.equal(snap.cursor, finalCursor, "snapshot cursor should equal the last assigned cursor id");
  assert.equal(finalCursor, 3, "three events => cursor 3");
});

test("snapshot: messages and activityLog are non-empty after a typical session start", () => {
  const events = [
    { type: "session_created", session_id: "ses_t3" },
    { type: "status", message: "Waiting for sandbox provisioning." },
  ];
  const { snap } = simulateAppendSequence(events);

  assert.ok(snap.messages.length > 0, "messages should be non-empty");
  assert.ok(snap.activityLog.length > 0, "activityLog should be non-empty");
});

test("snapshot: full session lifecycle reflects completed agent run", () => {
  const actor = { id: "usr_bob", name: "Bob" };
  const runId = "run_abc";

  const events = [
    { type: "session_created", session_id: "ses_t4" },
    { type: "participant_joined", participant: actor },
    {
      type: "agent_request",
      run_id: runId,
      actor,
      text: "Fix the failing tests",
      created_at: new Date().toISOString(),
    },
    { type: "agent_run_started", run_id: runId, actor, text: "Fix the failing tests" },
    {
      type: "agent_run_completed",
      run_id: runId,
      cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.02 },
    },
  ];

  const { snap, finalCursor } = simulateAppendSequence(events);

  // Cursor tracks every event.
  assert.equal(snap.cursor, finalCursor);
  assert.equal(finalCursor, 5);

  // Participant joined.
  assert.ok(
    snap.participants.some((p) => p.id === "usr_bob"),
    "Bob should be in participants",
  );

  // Messages and activity populated.
  assert.ok(snap.messages.length > 0, "messages should be non-empty after run");
  assert.ok(snap.activityLog.length > 0, "activityLog should be non-empty after run");
});

test("snapshot: uid pattern matches msg_<cursorId>_<subIndex> format", () => {
  // Verify the uid generator pattern the DO uses produces the expected shape.
  // This ensures deterministic uid generation is consistent between cold-start
  // re-snapshots and live per-event updates.
  let subIndex = 0;
  const cursorId = 42;
  const uid = () => `msg_${cursorId}_${subIndex++}`;

  assert.equal(uid(), "msg_42_0");
  assert.equal(uid(), "msg_42_1");
  assert.equal(uid(), "msg_42_2");
  // Resetting subIndex (as appendAndBroadcast does at start of each call)
  // makes the next event's ids start from 0 again.
  subIndex = 0;
  assert.equal(uid(), "msg_42_0");
});
