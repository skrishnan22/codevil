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
  BriefDispatchedEventSchema,
  AnnotationsConsumedEventSchema,
  ApproveRunMessageSchema,
  RefineRunMessageSchema,
  AbortRunMessageSchema,
  QuestionOptionSchema,
  AnswerableBySchema,
  QuestionRaisedEventSchema,
  QuestionAssignedEventSchema,
  QuestionAnsweredEventSchema,
  QuestionAssignMessageSchema,
  QuestionAnswerMessageSchema,
  DOToCLIEventSchema,
  CLIToDOMessageSchema,
  PersistedDOToCLIEventSchema,
} from "../dist/index.js";

// Canonical fixture for the new AnnotationAnchor shape.
const validAnchor = {
  startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 10 },
  endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 46 },
  text: "Use a read-only Pi consolidation turn",
  blockId: "block-001",
  sourceLine: 5,
};

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
  const anchor = validAnchor;

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

  assert.equal(created.anchor.text, anchor.text);
  assert.equal(replied.comment, "Agreed, and keep the turn no-tools.");
  assert.equal(withdrawn.thread_id, "ann_123");
  assert.equal(CLIToDOMessageSchema.parse(created).type, "annotation_create");
  assert.equal(CLIToDOMessageSchema.parse(replied).type, "annotation_reply");
  assert.equal(CLIToDOMessageSchema.parse(withdrawn).type, "annotation_withdraw");
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
  const anchor = validAnchor;
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
  assert.equal(BriefDispatchedEventSchema.parse({
    type: "brief_dispatched",
    run_id: "run_123",
    from_round: 0,
    to_round: 1,
    brief: "Require read-only Pi consolidation.",
  }).brief, "Require read-only Pi consolidation.");
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

// --- ask_question building blocks ---

test("QuestionOptionSchema accepts valid option", () => {
  const parsed = QuestionOptionSchema.parse({ id: "opt-1", label: "Option A", detail: "Some extra detail" });
  assert.equal(parsed.id, "opt-1");
  assert.equal(parsed.label, "Option A");
  assert.equal(parsed.detail, "Some extra detail");
});

test("QuestionOptionSchema rejects empty id", () => {
  assert.throws(() => QuestionOptionSchema.parse({ id: "", label: "A" }));
});

test("QuestionOptionSchema rejects empty label", () => {
  assert.throws(() => QuestionOptionSchema.parse({ id: "opt-1", label: "" }));
});

test("AnswerableBySchema accepts decider and anyone", () => {
  assert.equal(AnswerableBySchema.parse("decider"), "decider");
  assert.equal(AnswerableBySchema.parse("anyone"), "anyone");
});

test("AnswerableBySchema rejects unknown values", () => {
  assert.throws(() => AnswerableBySchema.parse("everyone"));
});

test("AnswerableBySchema accepts assigned question policy", () => {
  assert.equal(AnswerableBySchema.parse("assigned"), "assigned");
});

// --- DO → CLI: question events ---

test("QuestionRaisedEventSchema parses valid question_raised event", () => {
  const parsed = QuestionRaisedEventSchema.parse({
    type: "question_raised",
    request_id: "req_1",
    run_id: "run_1",
    question: "Which approach should we use?",
    options: [{ id: "opt-1", label: "Option A" }, { id: "opt-2", label: "Option B" }],
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
    status: "open",
    raised_at: "2024-01-01T00:00:00.000Z",
  });
  assert.equal(parsed.type, "question_raised");
  assert.equal(parsed.request_id, "req_1");
  assert.equal(parsed.options.length, 2);
  assert.equal(parsed.status, "open");
  assert.equal(parsed.raised_at, "2024-01-01T00:00:00.000Z");
});

test("QuestionRaisedEventSchema preserves assigned participant", () => {
  const parsed = QuestionRaisedEventSchema.parse({
    type: "question_raised",
    request_id: "req_assigned",
    run_id: "run_1",
    question: "Who should decide?",
    allow_freeform: true,
    allow_multiple: false,
    answerable_by: "assigned",
    assigned_to: { id: "usr_2", name: "Bob" },
    status: "open",
    raised_at: "2024-01-01T00:00:00.000Z",
  });
  assert.equal(parsed.assigned_to.id, "usr_2");
});

test("QuestionRaisedEventSchema parses freeform-only question (no options)", () => {
  const parsed = QuestionRaisedEventSchema.parse({
    type: "question_raised",
    request_id: "req_2",
    run_id: "run_1",
    question: "Describe the issue in detail.",
    context: "Background context here.",
    allow_freeform: true,
    allow_multiple: false,
    answerable_by: "anyone",
    status: "open",
    raised_at: "2024-01-01T00:00:00.000Z",
  });
  assert.equal(parsed.context, "Background context here.");
  assert.equal(parsed.options, undefined);
});

test("QuestionRaisedEventSchema rejects event without raised_at", () => {
  assert.throws(() =>
    QuestionRaisedEventSchema.parse({
      type: "question_raised",
      request_id: "req_3",
      run_id: "run_1",
      question: "Anything?",
      allow_freeform: true,
      allow_multiple: false,
      answerable_by: "anyone",
      status: "open",
    }),
  );
});

test("DOToCLIEventSchema accepts question_raised events", () => {
  const parsed = DOToCLIEventSchema.parse({
    type: "question_raised",
    request_id: "req_1",
    run_id: "run_1",
    question: "Pick one.",
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
    status: "open",
    raised_at: "2024-01-01T00:00:00.000Z",
  });
  assert.equal(parsed.type, "question_raised");
});

test("QuestionAssignedEventSchema parses assignment updates", () => {
  const parsed = QuestionAssignedEventSchema.parse({
    type: "question_assigned",
    request_id: "req_1",
    assigned_to: { id: "usr_2", name: "Bob" },
    assigned_by: { id: "usr_1", name: "Alice" },
    assigned_at: "2026-06-14T11:00:00.000Z",
  });
  assert.equal(parsed.assigned_to.name, "Bob");
});

test("DOToCLIEventSchema accepts question_assigned events", () => {
  const parsed = DOToCLIEventSchema.parse({
    type: "question_assigned",
    request_id: "req_1",
    assigned_to: { id: "usr_2", name: "Bob" },
    assigned_by: { id: "usr_1", name: "Alice" },
    assigned_at: "2026-06-14T11:00:00.000Z",
  });
  assert.equal(parsed.type, "question_assigned");
});

test("QuestionAnsweredEventSchema parses valid question_answered event", () => {
  const parsed = QuestionAnsweredEventSchema.parse({
    type: "question_answered",
    request_id: "req_1",
    option_ids: ["opt-1"],
    freeform: "Additional note",
    answered_by: { id: "usr_1", name: "Alice" },
    answered_at: "2026-06-14T10:00:00.000Z",
  });
  assert.equal(parsed.answered_by.name, "Alice");
  assert.equal(parsed.option_ids[0], "opt-1");
});

test("DOToCLIEventSchema accepts question_answered events", () => {
  const parsed = DOToCLIEventSchema.parse({
    type: "question_answered",
    request_id: "req_1",
    option_ids: ["opt-2"],
    answered_by: { id: "usr_2", name: "Bob" },
    answered_at: "2026-06-14T11:00:00.000Z",
  });
  assert.equal(parsed.type, "question_answered");
});

// --- CLI → DO: question_answer ---

test("QuestionAnswerMessageSchema accepts answer with only option_ids", () => {
  const parsed = QuestionAnswerMessageSchema.parse({
    type: "question_answer",
    request_id: "req_1",
    option_ids: ["opt-1"],
  });
  assert.equal(parsed.type, "question_answer");
  assert.deepEqual(parsed.option_ids, ["opt-1"]);
});

test("QuestionAnswerMessageSchema accepts answer with only freeform", () => {
  const parsed = QuestionAnswerMessageSchema.parse({
    type: "question_answer",
    request_id: "req_1",
    freeform: "This is my freeform answer.",
  });
  assert.equal(parsed.freeform, "This is my freeform answer.");
});

test("QuestionAnswerMessageSchema accepts answer with both option_ids and freeform", () => {
  const parsed = QuestionAnswerMessageSchema.parse({
    type: "question_answer",
    request_id: "req_1",
    option_ids: ["opt-1"],
    freeform: "Also some extra context.",
  });
  assert.equal(parsed.option_ids[0], "opt-1");
  assert.equal(parsed.freeform, "Also some extra context.");
});

test("QuestionAnswerMessageSchema rejects answer with neither option_ids nor freeform", () => {
  assert.throws(() =>
    QuestionAnswerMessageSchema.parse({
      type: "question_answer",
      request_id: "req_1",
    }),
  );
});

test("QuestionAnswerMessageSchema rejects answer with empty option_ids and no freeform", () => {
  assert.throws(() =>
    QuestionAnswerMessageSchema.parse({
      type: "question_answer",
      request_id: "req_1",
      option_ids: [],
    }),
  );
});

test("QuestionAnswerMessageSchema rejects answer with empty option_ids and empty freeform after trim", () => {
  assert.throws(() =>
    QuestionAnswerMessageSchema.parse({
      type: "question_answer",
      request_id: "req_1",
      option_ids: [],
      freeform: "   ",
    }),
  );
});

test("CLIToDOMessageSchema accepts question_answer messages", () => {
  const parsed = CLIToDOMessageSchema.parse({
    type: "question_answer",
    request_id: "req_1",
    option_ids: ["opt-1"],
  });
  assert.equal(parsed.type, "question_answer");
});

test("QuestionAssignMessageSchema accepts assignment messages", () => {
  const parsed = QuestionAssignMessageSchema.parse({
    type: "question_assign",
    request_id: "req_1",
    assigned_to: { id: "usr_2", name: "Bob" },
  });
  assert.equal(parsed.assigned_to.id, "usr_2");
});

test("CLIToDOMessageSchema accepts question_assign messages", () => {
  const parsed = CLIToDOMessageSchema.parse({
    type: "question_assign",
    request_id: "req_1",
    assigned_to: { id: "usr_2", name: "Bob" },
  });
  assert.equal(parsed.type, "question_assign");
});
