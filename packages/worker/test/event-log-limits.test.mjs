import assert from "node:assert/strict";
import test from "node:test";

import {
  capEventForStorage,
  capSessionSnapshotForStorage,
  eventJsonByteLength,
  MAX_EVENT_JSON_BYTES,
  MAX_EVENTS_BETWEEN_SNAPSHOTS,
  MAX_PREVIEW_OUTPUT_LINE_CHARS,
  MAX_SESSION_SNAPSHOT_BYTES,
  prepareSnapshotCheckpoint,
  shouldCompactEventTail,
} from "../dist/orchestrator/event-log-limits.js";

test("capEventForStorage leaves small events unchanged", () => {
  const event = { type: "status", message: "hello" };
  const result = capEventForStorage(event);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.event, event);
});

test("shouldCompactEventTail caps a long uncheckpointed replay tail deterministically", () => {
  assert.equal(shouldCompactEventTail(MAX_EVENTS_BETWEEN_SNAPSHOTS - 1), false);
  assert.equal(shouldCompactEventTail(MAX_EVENTS_BETWEEN_SNAPSHOTS), true);
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

test("capSessionSnapshotForStorage keeps structural state and deterministically evicts oldest display history", () => {
  const snapshot = {
    cursor: 42,
    sessionPhase: "executing",
    planApproved: true,
    participants: [{ id: "owner", name: "Owner" }],
    preview: {
      status: "ready", url: "https://preview.example", command: "pnpm dev", port: 3000,
      error: null, apps: [], selectedAppKey: null, reloadRevision: 0,
      outputLines: ["output".repeat(MAX_PREVIEW_OUTPUT_LINE_CHARS)],
    },
    planRevision: { runId: "run_1", round: 1, markdown: "# Plan", locked: true, createdAt: null, revisionId: null },
    annotations: [],
    questions: [],
    selectedAnnotationId: null,
    messages: Array.from({ length: 60 }, (_unused, index) => ({
      id: `message_${index}`, role: "assistant", variant: "text", content: String(index).repeat(12_000), timestamp: index,
    })),
    activityLog: Array.from({ length: 60 }, (_unused, index) => ({
      id: `activity_${index}`, kind: "event", status: "success", timestamp: index,
      event: { label: "status", detail: String(index).repeat(12_000) },
    })),
  };

  const capped = capSessionSnapshotForStorage(snapshot);

  assert.ok(eventJsonByteLength(JSON.stringify(capped)) <= MAX_SESSION_SNAPSHOT_BYTES);
  assert.equal(capped.cursor, 42);
  assert.equal(capped.sessionPhase, "executing");
  assert.deepEqual(capped.participants, snapshot.participants);
  assert.deepEqual(capped.planRevision, snapshot.planRevision);
  assert.ok(capped.preview.outputLines[0].length < snapshot.preview.outputLines[0].length);
  assert.ok(capped.messages.length < snapshot.messages.length);
  assert.equal(capped.messages.at(-1)?.id, "message_59");
  assert.equal(capped.activityLog.at(-1)?.id, "activity_59");
});

test("prepareSnapshotCheckpoint refuses an oversized structural snapshot without truncating it", () => {
  const snapshot = {
    cursor: 42,
    sessionPhase: "executing",
    planApproved: true,
    participants: [],
    preview: { status: "idle", url: null, command: null, port: null, error: null, apps: [], selectedAppKey: null, reloadRevision: 0, outputLines: [] },
    planRevision: { runId: "run_1", round: 1, markdown: "x".repeat(MAX_SESSION_SNAPSHOT_BYTES), locked: true, createdAt: null, revisionId: null },
    annotations: [],
    questions: [],
    selectedAnnotationId: null,
    messages: [],
    activityLog: [],
  };

  const result = prepareSnapshotCheckpoint(snapshot);

  assert.equal(result.canPersist, false);
  assert.equal(result.snapshot.planRevision.markdown, snapshot.planRevision.markdown);
});
