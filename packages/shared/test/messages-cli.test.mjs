import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StatusEventSchema,
  ErrorEventSchema,
  RoomReadyEventSchema,
  ParticipantJoinedEventSchema,
  ParticipantLeftEventSchema,
  HumanMessageEventSchema,
  HumanChatMessageSchema,
  AgentRequestMessageSchema,
  AgentRequestEventSchema,
  AgentRequestQueuedEventSchema,
  AgentRunStartedEventSchema,
  ApprovalRequestedEventSchema,
  AgentRunCompletedEventSchema,
  AgentRunFailedEventSchema,
  AgentResponseEventSchema,
  ApproveRunMessageSchema,
  RefineRunMessageSchema,
  AbortRunMessageSchema,
  DOToCLIEventSchema,
  CLIToDOMessageSchema,
  PersistedDOToCLIEventSchema,
} from "../dist/index.js";

test("StatusEventSchema preserves an optional actor field", () => {
  const parsed = StatusEventSchema.parse({
    type: "status",
    message: "Plan approved. Starting execution.",
    actor: "Alice",
  });
  assert.equal(parsed.actor, "Alice");
});

test("ErrorEventSchema preserves an optional actor field", () => {
  const parsed = ErrorEventSchema.parse({
    type: "error",
    message: "Alice already approved this plan.",
    actor: "Alice",
  });
  assert.equal(parsed.actor, "Alice");
});

test("StatusEventSchema is valid without an actor (backward compatible)", () => {
  const parsed = StatusEventSchema.parse({
    type: "status",
    message: "Cloning repo.",
  });
  assert.equal(parsed.actor, undefined);
});

test("an actor-bearing status event round-trips through the persisted schema", () => {
  const event = { type: "status", message: "Refining plan.", actor: "Bob" };
  const persisted = PersistedDOToCLIEventSchema.parse(event);
  assert.equal(persisted.actor, "Bob");
});

test("RoomReadyEventSchema carries the cloned repo", () => {
  const parsed = RoomReadyEventSchema.parse({
    type: "room_ready",
    repo: "github.com/acme/app",
  });
  assert.equal(parsed.repo, "github.com/acme/app");
});

test("DOToCLIEventSchema accepts room_ready events", () => {
  const parsed = DOToCLIEventSchema.parse({
    type: "room_ready",
    repo: "github.com/acme/app",
  });
  assert.equal(parsed.type, "room_ready");
});

test("participant join and leave events carry participant identity", () => {
  const joined = ParticipantJoinedEventSchema.parse({
    type: "participant_joined",
    participant: { id: "usr_123", name: "Alice" },
  });
  const left = ParticipantLeftEventSchema.parse({
    type: "participant_left",
    participant: { id: "usr_123", name: "Alice" },
  });

  assert.equal(joined.participant.name, "Alice");
  assert.equal(left.participant.id, "usr_123");
});

test("human message events carry actor, text, and timestamp", () => {
  const parsed = HumanMessageEventSchema.parse({
    type: "human_message",
    id: "msg_123",
    actor: { id: "usr_123", name: "Alice" },
    text: "hello room",
    created_at: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(parsed.actor.name, "Alice");
  assert.equal(parsed.text, "hello room");
});

test("CLIToDOMessageSchema accepts human chat messages", () => {
  const parsed = CLIToDOMessageSchema.parse({
    type: "human_message",
    text: "hello room",
  });

  assert.equal(parsed.text, "hello room");
});

test("CLIToDOMessageSchema accepts agent requests", () => {
  const parsed = AgentRequestMessageSchema.parse({
    type: "agent_request",
    text: "fix the broken test",
  });

  assert.equal(parsed.text, "fix the broken test");
  assert.equal(CLIToDOMessageSchema.parse(parsed).type, "agent_request");
});

test("agent request and run lifecycle events carry run identity", () => {
  const actor = { id: "usr_123", name: "Alice" };
  const requested = AgentRequestEventSchema.parse({
    type: "agent_request",
    run_id: "run_123",
    actor,
    text: "fix bug",
    created_at: "2026-06-03T00:00:00.000Z",
  });
  const queued = AgentRequestQueuedEventSchema.parse({
    type: "agent_request_queued",
    run_id: "run_124",
    position: 2,
  });
  const started = AgentRunStartedEventSchema.parse({
    type: "agent_run_started",
    run_id: "run_123",
    actor,
    text: "fix bug",
  });
  const approval = ApprovalRequestedEventSchema.parse({
    type: "approval_requested",
    run_id: "run_123",
    plan: "## Plan",
    cost: { input_tokens: 1, output_tokens: 2, total_cost_usd: 0.01 },
    refinement_round: 0,
  });
  const completed = AgentRunCompletedEventSchema.parse({
    type: "agent_run_completed",
    run_id: "run_123",
    pr_url: "https://github.com/acme/app/pull/1",
  });
  const failed = AgentRunFailedEventSchema.parse({
    type: "agent_run_failed",
    run_id: "run_123",
    message: "tests failed",
  });

  assert.equal(requested.actor.name, "Alice");
  assert.equal(queued.position, 2);
  assert.equal(started.text, "fix bug");
  assert.equal(approval.cost.total_cost_usd, 0.01);
  assert.equal(completed.pr_url, "https://github.com/acme/app/pull/1");
  assert.equal(failed.message, "tests failed");
  assert.equal(DOToCLIEventSchema.parse(approval).type, "approval_requested");
});

test("run-scoped approval messages carry the selected run", () => {
  assert.equal(ApproveRunMessageSchema.parse({ type: "approve_run", run_id: "run_123" }).run_id, "run_123");
  assert.equal(RefineRunMessageSchema.parse({ type: "refine_run", run_id: "run_123", feedback: "narrow it" }).feedback, "narrow it");
  assert.equal(AbortRunMessageSchema.parse({ type: "abort_run", run_id: "run_123" }).run_id, "run_123");
  assert.equal(CLIToDOMessageSchema.parse({ type: "approve_run", run_id: "run_123" }).type, "approve_run");
});

test("agent responses carry the final conversational answer", () => {
  const parsed = AgentResponseEventSchema.parse({
    type: "agent_response",
    run_id: "run_123",
    text: "The retry logic lives in src/retry.ts.",
  });

  assert.equal(parsed.text, "The retry logic lives in src/retry.ts.");
  assert.equal(DOToCLIEventSchema.parse(parsed).type, "agent_response");
});
