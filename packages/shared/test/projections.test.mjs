import assert from "node:assert/strict";
import test from "node:test";

import {
  mapEventToChat,
  mapEventToActivity,
  projectEvent,
  applyToSessionSnapshot,
  applyToChatActivity,
  emptySessionSnapshot,
  inferPhase,
  inferPlanApproved,
  reducePreviewState,
  reducePlanRevision,
  reduceParticipants,
  reduceAnnotations,
  reduceQuestions,
  parseRaisedAt,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(now = 1_000_000) {
  let counter = 0;
  return { uid: () => `msg_${++counter}`, now };
}

// ---------------------------------------------------------------------------
// mapEventToChat
// ---------------------------------------------------------------------------

test("mapEventToChat: maps session_created to a system message", () => {
  const event = { type: "session_created", session_id: "ses_abc" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].variant, "status");
  assert.ok(messages[0].content.includes("ses_abc"));
});

test("mapEventToChat: maps status to a system message", () => {
  const event = { type: "status", message: "Provisioning sandbox..." };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].variant, "status");
  assert.equal(messages[0].content, "Provisioning sandbox...");
});

test("mapEventToChat: carries the actor from an attributed status event", () => {
  const event = { type: "status", message: "Plan approved. Starting execution.", actor: "Alice" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages[0].actor, "Alice");
});

test("mapEventToChat: leaves actor undefined for an unattributed status event", () => {
  const event = { type: "status", message: "Cloning repo." };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages[0].actor, undefined);
});

test("mapEventToChat: maps room_ready to a room-ready status message", () => {
  const event = { type: "room_ready", repo: "github.com/acme/app" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].variant, "status");
  assert.equal(messages[0].content, "Room ready for github.com/acme/app");
});

test("mapEventToChat: keeps participant join and leave noise out of conversation", () => {
  const ctx = makeCtx();
  const joined = mapEventToChat({ type: "participant_joined", participant: { id: "usr_123", name: "Alice" } }, ctx);
  const left = mapEventToChat({ type: "participant_left", participant: { id: "usr_123", name: "Alice" } }, ctx);
  assert.deepEqual(joined, []);
  assert.deepEqual(left, []);
});

test("mapEventToChat: maps human messages to user chat messages with actor attribution", () => {
  const messages = mapEventToChat({
    type: "human_message",
    id: "msg_123",
    actor: { id: "usr_123", name: "Alice" },
    text: "hello room",
    created_at: "2026-06-03T00:00:00.000Z",
  }, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].variant, "text");
  assert.equal(messages[0].content, "hello room");
  assert.equal(messages[0].actor, "Alice");
  assert.equal(messages[0].meta?.actor_id, "usr_123");
});

test("mapEventToChat: carries the actor from an attributed error event", () => {
  const event = { type: "error", message: "Alice already approved this plan.", actor: "Alice" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages[0].actor, "Alice");
});

test("mapEventToChat: does not render awaiting approval status separately", () => {
  const event = { type: "status", message: "Waiting for user approval." };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 0);
});

test("mapEventToChat: keeps phase events out of conversation", () => {
  const event = { type: "phase", phase: "planning", model: "claude-sonnet-4-6" };
  const messages = mapEventToChat(event, makeCtx());
  assert.deepEqual(messages, []);
});

test("mapEventToChat: maps plan_ready to a plan message", () => {
  const event = {
    type: "plan_ready",
    plan: "## Plan\n\n1. Do X",
    cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.01 },
    refinement_round: 0,
  };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].variant, "plan");
  assert.equal(messages[0].content, "## Plan\n\n1. Do X");
  assert.equal(messages[0].meta?.cost?.total_cost_usd, 0.01);
  assert.equal(messages[0].meta?.refinement_round, 0);
});

test("mapEventToChat: maps approval_requested to a plan message scoped to the run", () => {
  const event = {
    type: "approval_requested",
    run_id: "run_123",
    plan: "## Plan\n\n1. Do X",
    cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.01 },
    refinement_round: 0,
  };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].variant, "plan");
  assert.equal(messages[0].meta?.run_id, "run_123");
});

test("mapEventToChat: keeps completed agent tools out of conversation", () => {
  const event = {
    type: "agent_event",
    event: { type: "tool_execution_end", tool: "bash", args: { command: "npm test" }, success: true },
  };
  const messages = mapEventToChat(event, makeCtx());
  assert.deepEqual(messages, []);
});

test("mapEventToChat: maps complete to a complete message with pr_url", () => {
  const event = { type: "complete", pr_url: "https://github.com/user/repo/pull/1" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].variant, "complete");
  assert.equal(messages[0].meta?.pr_url, "https://github.com/user/repo/pull/1");
});

test("mapEventToChat: maps error to an error message", () => {
  const event = { type: "error", message: "Something broke" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].variant, "error");
  assert.equal(messages[0].content, "Something broke");
});

test("mapEventToChat: maps verification_failed to a verification_failed message", () => {
  const event = { type: "verification_failed", attempts: 3, last_error: "test failed" };
  const messages = mapEventToChat(event, makeCtx());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].variant, "verification_failed");
  assert.equal(messages[0].meta?.attempts, 3);
  assert.equal(messages[0].meta?.last_error, "test failed");
});

// ---------------------------------------------------------------------------
// projectEvent
// ---------------------------------------------------------------------------

test("projectEvent: coalesces streamed message updates into one thinking entry", () => {
  const ctx = makeCtx();
  const first = projectEvent(
    { messages: [], activityLog: [] },
    { type: "agent_event", event: { type: "message_update", content: "Analyzing " } },
    ctx,
  );
  const second = projectEvent(
    first,
    { type: "agent_event", event: { type: "message_update", content: "the repo." } },
    ctx,
  );
  assert.equal(second.messages.length, 0);
  assert.equal(second.activityLog.length, 1);
  assert.equal(second.activityLog[0].kind, "thinking");
  assert.equal(second.activityLog[0].thinking?.text, "Analyzing the repo.");
});

test("projectEvent: updates a running tool entry when the matching tool ends", () => {
  const ctx = makeCtx();
  const started = projectEvent(
    { messages: [], activityLog: [] },
    { type: "agent_event", event: { type: "tool_execution_start", tool: "bash", args: { command: "pnpm test" } } },
    ctx,
  );
  const ended = projectEvent(
    started,
    { type: "agent_event", event: { type: "tool_execution_end", tool: "bash", args: { command: "pnpm test" }, result: "PASS", success: true } },
    ctx,
  );
  assert.equal(ended.messages.length, 0);
  assert.equal(ended.activityLog.length, 1);
  assert.equal(ended.activityLog[0].status, "success");
  assert.equal(ended.activityLog[0].tool?.result, "PASS");
});

// ---------------------------------------------------------------------------
// mapEventToActivity
// ---------------------------------------------------------------------------

test("mapEventToActivity: maps agent_event tool_execution_start to running tool_call", () => {
  const event = {
    type: "agent_event",
    event: { type: "tool_execution_start", tool: "bash", args: { command: "npm test" } },
  };
  const entries = mapEventToActivity(event, makeCtx());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "tool_call");
  assert.equal(entries[0].status, "running");
  assert.equal(entries[0].tool?.name, "bash");
  assert.equal(entries[0].tool?.summary, "Run npm test");
});

test("mapEventToActivity: maps agent_event tool_execution_end to completed tool_call", () => {
  const event = {
    type: "agent_event",
    event: { type: "tool_execution_end", tool: "bash", args: { command: "npm test" }, result: "PASS", success: true },
  };
  const entries = mapEventToActivity(event, makeCtx());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "tool_call");
  assert.equal(entries[0].status, "success");
  assert.equal(entries[0].tool?.result, "PASS");
});

test("mapEventToActivity: maps phase event to a phase_divider entry", () => {
  const event = { type: "phase", phase: "executing", model: "claude-opus-4-6" };
  const entries = mapEventToActivity(event, makeCtx());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "phase_divider");
  assert.ok(entries[0].phase?.label.includes("Agent turn"));
});

// ---------------------------------------------------------------------------
// inferPhase
// ---------------------------------------------------------------------------

test("inferPhase: moves verification failure into failed phase", () => {
  assert.equal(
    inferPhase({ type: "verification_failed", attempts: 5, last_error: "tests failed" }, "awaiting_approval"),
    "failed",
  );
});

test("inferPhase: starts general agent requests in the executing phase", () => {
  assert.equal(
    inferPhase({ type: "agent_run_started", run_id: "run_123", actor: { id: "usr_123", name: "Alice" }, text: "explain auth" }, "ready"),
    "executing",
  );
});

// ---------------------------------------------------------------------------
// inferPlanApproved
// ---------------------------------------------------------------------------

test("inferPlanApproved: marks a plan approved from the worker approval status", () => {
  assert.equal(
    inferPlanApproved({ type: "status", message: "Plan approved. Starting execution." }, false),
    true,
  );
});

// ---------------------------------------------------------------------------
// reducePreviewState
// ---------------------------------------------------------------------------

test("reducePreviewState: tracks preview readiness and stop events", () => {
  const idle = {
    status: "idle",
    url: null,
    command: null,
    port: null,
    error: null,
    apps: [],
    selectedAppKey: null,
    reloadRevision: 0,
    outputLines: [],
  };
  const starting = reducePreviewState(idle, { type: "preview_starting", command: "pnpm dev", port: 5173 });
  assert.equal(starting.status, "starting");
  assert.equal(starting.command, "pnpm dev");

  const ready = reducePreviewState(starting, { type: "preview_ready", url: "https://preview.example/", command: "pnpm dev", port: 5173 });
  assert.equal(ready.status, "ready");
  assert.equal(ready.url, "https://preview.example/");

  assert.equal(reducePreviewState(ready, { type: "preview_stopped" }).status, "idle");
});

// ---------------------------------------------------------------------------
// reducePlanRevision
// ---------------------------------------------------------------------------

test("reducePlanRevision: sets revision state when plan_revision_frozen arrives with markdown", () => {
  const result = reducePlanRevision(null, {
    type: "plan_revision_frozen",
    run_id: "run_abc",
    round: 1,
    markdown: "# My Plan\n\nDo the thing.",
    locked: false,
    created_at: "2024-01-01T00:00:00Z",
    revision_id: "rev_1",
  });
  assert.ok(result !== null);
  assert.equal(result.runId, "run_abc");
  assert.equal(result.round, 1);
  assert.equal(result.markdown, "# My Plan\n\nDo the thing.");
  assert.equal(result.locked, false);
});

// ---------------------------------------------------------------------------
// reduceAnnotations
// ---------------------------------------------------------------------------

const anchor = {
  startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
  endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 5 },
  text: "hello",
  blockId: "block-10-20",
  sourceLine: 3,
};
const author = { id: "usr_1", name: "Alice" };
function makeThread(id, overrides = {}) {
  return { id, run_id: "run_abc", round: 1, anchor, author, comment: `Comment from ${id}`, status: "open", created_at: "2024-01-01T00:00:00Z", ...overrides };
}

test("reduceAnnotations: appends a new annotation thread", () => {
  const thread = makeThread("t1");
  const result = reduceAnnotations([], { type: "annotation_created", annotation: thread });
  assert.equal(result.length, 1);
  assert.equal(result[0], thread);
});

test("reduceAnnotations: dedupes by id", () => {
  const t1 = makeThread("t1");
  const t1Dup = makeThread("t1", { comment: "different" });
  const after1 = reduceAnnotations([], { type: "annotation_created", annotation: t1 });
  const after2 = reduceAnnotations(after1, { type: "annotation_created", annotation: t1Dup });
  assert.equal(after2.length, 1);
  assert.equal(after2[0].comment, "Comment from t1");
});

// ---------------------------------------------------------------------------
// reduceQuestions
// ---------------------------------------------------------------------------

test("reduceQuestions: appends a new question when question_raised", () => {
  const result = reduceQuestions([], {
    type: "question_raised",
    request_id: "req_1",
    run_id: "run_abc",
    question: "Question req_1",
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
    status: "open",
    raised_at: "2024-01-01T00:00:00.000Z",
  }, makeCtx());
  assert.equal(result.length, 1);
  assert.equal(result[0].requestId, "req_1");
  assert.equal(result[0].status, "open");
});

// ---------------------------------------------------------------------------
// parseRaisedAt
// ---------------------------------------------------------------------------

test("parseRaisedAt: parses an ISO timestamp", () => {
  assert.equal(
    parseRaisedAt("2024-01-01T00:00:00.000Z", 9999),
    Date.parse("2024-01-01T00:00:00.000Z"),
  );
});

test("parseRaisedAt: falls back to the provided fallback when undefined", () => {
  const fallback = 1234567890;
  const out = parseRaisedAt(undefined, fallback);
  assert.equal(out, fallback);
});

test("parseRaisedAt: falls back to the provided fallback when unparseable", () => {
  const fallback = 9999;
  const out = parseRaisedAt("not-a-date", fallback);
  assert.equal(out, fallback);
});

// ---------------------------------------------------------------------------
// applyToSessionSnapshot
// ---------------------------------------------------------------------------

test("applyToSessionSnapshot: advances cursor and updates sessionPhase", () => {
  const snap = emptySessionSnapshot();
  const ctx = makeCtx();
  const next = applyToSessionSnapshot(snap, 5, { type: "session_created", session_id: "ses_1" }, ctx);
  assert.equal(next.cursor, 5);
  assert.equal(next.sessionPhase, "initializing");
  assert.equal(next.messages.length, 1);
  assert.ok(next.activityLog.length >= 1);
});

test("applyToSessionSnapshot: resets selectedAnnotationId on new plan revision", () => {
  const snap = {
    ...emptySessionSnapshot(),
    planRevision: { runId: "run_old", round: 1, markdown: "# old", locked: false, createdAt: null, revisionId: null },
    annotations: [makeThread("t1")],
    selectedAnnotationId: "t1",
  };
  const ctx = makeCtx();
  const next = applyToSessionSnapshot(snap, 1, {
    type: "plan_revision_frozen",
    run_id: "run_new",
    round: 2,
    markdown: "# new plan",
    locked: false,
  }, ctx);
  assert.equal(next.selectedAnnotationId, null);
  assert.equal(next.annotations.length, 0);
});

test("applyToSessionSnapshot: preserves selectedAnnotationId when revision is unchanged", () => {
  const snap = {
    ...emptySessionSnapshot(),
    planRevision: { runId: "run_abc", round: 1, markdown: "# plan", locked: false, createdAt: null, revisionId: null },
    annotations: [makeThread("t1")],
    selectedAnnotationId: "t1",
  };
  const ctx = makeCtx();
  const next = applyToSessionSnapshot(snap, 2, { type: "status", message: "Some status" }, ctx);
  assert.equal(next.selectedAnnotationId, "t1");
});

test("applyToSessionSnapshot: messages and activityLog accumulate across events", () => {
  let snap = emptySessionSnapshot();
  const ctx = makeCtx();
  snap = applyToSessionSnapshot(snap, 1, { type: "session_created", session_id: "ses_1" }, ctx);
  snap = applyToSessionSnapshot(snap, 2, { type: "status", message: "Provisioning sandbox..." }, ctx);
  assert.ok(snap.messages.length >= 2);
  assert.ok(snap.activityLog.length >= 2);
});

// ---------------------------------------------------------------------------
// applyToChatActivity
// ---------------------------------------------------------------------------

test("applyToChatActivity: accumulates messages and activityLog without touching structural fields", () => {
  const ctx = makeCtx();
  const initial = { messages: [], activityLog: [] };
  const next = applyToChatActivity(initial, { type: "session_created", session_id: "ses_1" }, ctx);
  assert.ok(next.messages.length >= 1, "should produce at least one message");
  assert.ok(next.activityLog.length >= 1, "should produce at least one activity entry");
  // applyToChatActivity returns only messages and activityLog — no structural fields.
  assert.equal(Object.keys(next).sort().join(","), "activityLog,messages");
});

test("applyToChatActivity: accumulates across multiple events (batch simulation)", () => {
  const ctx = makeCtx();
  let state = { messages: [], activityLog: [] };
  state = applyToChatActivity(state, { type: "session_created", session_id: "ses_2" }, ctx);
  state = applyToChatActivity(state, { type: "status", message: "Provisioning sandbox..." }, ctx);
  assert.ok(state.messages.length >= 2);
  assert.ok(state.activityLog.length >= 2);
});
