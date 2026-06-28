import assert from "node:assert/strict";
import test from "node:test";

import {
  DOToCLIEventSchema,
  emptySessionSnapshot,
  parseReplayEvent,
  parseSessionSnapshot,
  SessionSnapshotSchema,
} from "../dist/index.js";

test("SessionSnapshotSchema: accepts emptySessionSnapshot", () => {
  const snap = emptySessionSnapshot();
  const parsed = SessionSnapshotSchema.parse(snap);
  assert.equal(parsed.cursor, 0);
  assert.equal(parsed.sessionPhase, null);
  assert.deepEqual(parsed.messages, []);
});

test("parseSessionSnapshot: returns null for corrupt blob", () => {
  assert.equal(parseSessionSnapshot({ cursor: "nope" }), null);
});

test("parseReplayEvent: strict path for valid live event", () => {
  const raw = { type: "status", message: "Hello" };
  const event = parseReplayEvent(raw);
  assert.equal(event?.type, "status");
  assert.equal(DOToCLIEventSchema.safeParse(event).success, true);
});

test("parseReplayEvent: lenient path for legacy unknown type", () => {
  const event = parseReplayEvent({ type: "future_event", whatever: 1 });
  assert.equal(event?.type, "future_event");
  assert.equal(event?.whatever, 1);
});

test("parseReplayEvent: drops event with no type", () => {
  assert.equal(parseReplayEvent({ message: "no type" }), null);
});

test("parseReplayEvent: lenient path accepts incomplete known type for legacy rows", () => {
  const event = parseReplayEvent({ type: "status" });
  assert.equal(event?.type, "status");
  assert.equal(DOToCLIEventSchema.safeParse(event).success, false);
});
