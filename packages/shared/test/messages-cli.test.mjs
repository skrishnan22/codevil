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
  AnnotationCreateMessageSchema,
  AnnotationReplyMessageSchema,
  AnnotationWithdrawMessageSchema,
  ConflictResolveMessageSchema,
  AgentRequestEventSchema,
  AgentRequestQueuedEventSchema,
  AgentRunStartedEventSchema,
  ApprovalRequestedEventSchema,
  AgentRunCompletedEventSchema,
  AgentRunFailedEventSchema,
  AgentResponseEventSchema,
  PlanRevisionFrozenEventSchema,
  AnnotationCreatedEventSchema,
  AnnotationRepliedEventSchema,
  AnnotationWithdrawnEventSchema,
  ConsolidationStartedEventSchema,
  ConflictRaisedEventSchema,
  ConflictResolvedEventSchema,
  BriefDispatchedEventSchema,
  AnnotationsConsumedEventSchema,
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
    plan_first: true,
  });

  assert.equal(parsed.text, "fix the broken test");
  assert.equal(parsed.plan_first, true);
  assert.equal(CLIToDOMessageSchema.parse(parsed).type, "agent_request");
});

test("CLIToDOMessageSchema accepts collaborative annotation messages", () => {
  const anchor = {
    quote: "Use a read-only Pi consolidation turn",
    prefix: "Resolve conflicts by calling",
    suffix: "then dispatch a brief.",
    startOffset: 10,
    endOffset: 46,
  };

  const created = AnnotationCreateMessageSchema.parse({
    type: "annotation_create",
    run_id: "run_123",
    round: 0,
    anchor,
    comment: "This needs to mention the sandbox contract.",
  });
  const replied = AnnotationReplyMessageSchema.parse({
    type: "annotation_reply",
    thread_id: "ann_123",
    comment: "Agreed, and keep the turn no-tools.",
  });
  const withdrawn = AnnotationWithdrawMessageSchema.parse({
    type: "annotation_withdraw",
    thread_id: "ann_123",
  });
  const selected = ConflictResolveMessageSchema.parse({
    type: "conflict_resolve",
    conflict_id: "conf_123",
    selected_thread_id: "ann_123",
  });
  const instructed = ConflictResolveMessageSchema.parse({
    type: "conflict_resolve",
    conflict_id: "conf_124",
    deciding_instruction: "Prefer the read-only consolidation wording.",
  });

  assert.equal(created.anchor.quote, anchor.quote);
  assert.equal(replied.comment, "Agreed, and keep the turn no-tools.");
  assert.equal(withdrawn.thread_id, "ann_123");
  assert.equal(selected.selected_thread_id, "ann_123");
  assert.equal(instructed.deciding_instruction, "Prefer the read-only consolidation wording.");
  assert.equal(CLIToDOMessageSchema.parse(created).type, "annotation_create");
  assert.equal(CLIToDOMessageSchema.parse(replied).type, "annotation_reply");
  assert.equal(CLIToDOMessageSchema.parse(withdrawn).type, "annotation_withdraw");
  assert.equal(CLIToDOMessageSchema.parse(selected).type, "conflict_resolve");
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

test("DOToCLIEventSchema accepts annotation collaboration events", () => {
  const actor = { id: "usr_123", name: "Alice" };
  const anchor = {
    quote: "Use a read-only Pi consolidation turn",
    prefix: "Resolve conflicts by calling",
    suffix: "then dispatch a brief.",
    startOffset: 10,
    endOffset: 46,
  };
  const annotation = {
    id: "ann_123",
    run_id: "run_123",
    round: 0,
    anchor,
    author: actor,
    comment: "Mention the sandbox contract.",
    status: "open",
    created_at: "2026-06-12T00:00:00.000Z",
  };
  const conflict = {
    id: "conf_123",
    run_id: "run_123",
    round: 0,
    summary: "Two comments disagree on read-only enforcement.",
    options: [
      { thread_id: "ann_123", gist: "Require read-only Pi consolidation." },
      { thread_id: "ann_124", gist: "Allow full sandbox tools." },
    ],
    status: "open",
  };

  assert.equal(PlanRevisionFrozenEventSchema.parse({
    type: "plan_revision_frozen",
    run_id: "run_123",
    round: 0,
    revision_id: "rev_123",
  }).revision_id, "rev_123");
  assert.equal(AnnotationCreatedEventSchema.parse({ type: "annotation_created", annotation }).annotation.status, "open");
  assert.equal(AnnotationRepliedEventSchema.parse({
    type: "annotation_replied",
    thread_id: "ann_123",
    reply: {
      id: "reply_123",
      author: actor,
      comment: "Yes.",
      created_at: "2026-06-12T00:01:00.000Z",
    },
  }).reply.comment, "Yes.");
  assert.equal(AnnotationWithdrawnEventSchema.parse({
    type: "annotation_withdrawn",
    thread_id: "ann_123",
    withdrawn_by: actor,
    withdrawn_at: "2026-06-12T00:02:00.000Z",
  }).thread_id, "ann_123");
  assert.equal(ConsolidationStartedEventSchema.parse({
    type: "consolidation_started",
    run_id: "run_123",
    round: 0,
  }).round, 0);
  assert.equal(ConflictRaisedEventSchema.parse({ type: "conflict_raised", conflict }).conflict.options.length, 2);
  assert.equal(ConflictResolvedEventSchema.parse({
    type: "conflict_resolved",
    conflict_id: "conf_123",
    resolved_by: actor,
    selected_thread_id: "ann_123",
  }).selected_thread_id, "ann_123");
  assert.equal(BriefDispatchedEventSchema.parse({
    type: "brief_dispatched",
    run_id: "run_123",
    from_round: 0,
    to_round: 1,
    brief_items: [
      { instruction: "Require read-only Pi consolidation.", source_thread_ids: ["ann_123"] },
    ],
  }).brief_items[0].source_thread_ids[0], "ann_123");
  assert.equal(AnnotationsConsumedEventSchema.parse({
    type: "annotations_consumed",
    run_id: "run_123",
    round: 0,
    thread_ids: ["ann_123"],
  }).thread_ids[0], "ann_123");
  assert.equal(DOToCLIEventSchema.parse({ type: "annotation_created", annotation }).type, "annotation_created");
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
