import { z } from "zod";
import { CostInfoSchema } from "./cost.js";
import { PreviewAppSchema } from "./preview.js";
import { ParticipantIdentitySchema } from "./room.js";
import { SessionSnapshotSchema } from "./session-snapshot-schema.js";
import {
  AnnotationAnchorSchema,
  AnnotationReplySchema,
  AnnotationThreadSchema,
} from "./annotations.js";
import { QuestionOptionSchema, AnswerableBySchema } from "./questions.js";

export { QuestionOptionSchema, AnswerableBySchema };

// --- DO → CLI events ---

export const SessionCreatedEventSchema = z.object({
  type: z.literal("session_created"),
  session_id: z.string(),
});

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  message: z.string(),
  // Optional display name of the teammate whose action produced this event
  // (multiplayer attribution). Absent for system-generated status events.
  actor: z.string().optional(),
});

export const CloneProgressEventSchema = z.object({
  type: z.literal("clone_progress"),
  line: z.string(),
});

export const PhaseEventSchema = z.object({
  type: z.literal("phase"),
  phase: z.enum(["planning", "executing"]),
  model: z.string(),
});

// AgentEvent payload is validated separately in the Sandbox (see pi-events.ts).
// Here it's an opaque pass-through that has already been validated upstream.
export const AgentEventWrapperSchema = z.object({
  type: z.literal("agent_event"),
  event: z.unknown(),
});

export const PlanReadyEventSchema = z.object({
  type: z.literal("plan_ready"),
  plan: z.string(),
  cost: CostInfoSchema,
  refinement_round: z.number(),
});

export const VerificationFailedEventSchema = z.object({
  type: z.literal("verification_failed"),
  attempts: z.number(),
  last_error: z.string(),
});

export const CompleteEventSchema = z.object({
  type: z.literal("complete"),
  pr_url: z.string(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  // Optional display name of the teammate the error refers to (multiplayer
  // attribution), e.g. naming whoever already decided on a plan.
  actor: z.string().optional(),
});

export const PreviewStartingEventSchema = z.object({
  type: z.literal("preview_starting"),
  command: z.string(),
  port: z.number(),
});

export const PreviewReadyEventSchema = z.object({
  type: z.literal("preview_ready"),
  url: z.string(),
  command: z.string(),
  port: z.number(),
});

export const PreviewErrorEventSchema = z.object({
  type: z.literal("preview_error"),
  message: z.string(),
});

export const PreviewStoppedEventSchema = z.object({
  type: z.literal("preview_stopped"),
});

export const PreviewAppsEventSchema = z.object({
  type: z.literal("preview_apps"),
  apps: z.array(PreviewAppSchema),
});

export const RoomReadyEventSchema = z.object({
  type: z.literal("room_ready"),
  repo: z.string(),
});

export const ParticipantJoinedEventSchema = z.object({
  type: z.literal("participant_joined"),
  participant: ParticipantIdentitySchema,
});

export const ParticipantLeftEventSchema = z.object({
  type: z.literal("participant_left"),
  participant: ParticipantIdentitySchema,
});

export const HumanMessageEventSchema = z.object({
  type: z.literal("human_message"),
  id: z.string(),
  actor: ParticipantIdentitySchema,
  text: z.string(),
  created_at: z.string(),
});

export const AgentRequestEventSchema = z.object({
  type: z.literal("agent_request"),
  run_id: z.string(),
  actor: ParticipantIdentitySchema,
  text: z.string(),
  created_at: z.string(),
});

export const AgentRequestQueuedEventSchema = z.object({
  type: z.literal("agent_request_queued"),
  run_id: z.string(),
  position: z.number(),
});

export const AgentRunStartedEventSchema = z.object({
  type: z.literal("agent_run_started"),
  run_id: z.string(),
  actor: ParticipantIdentitySchema,
  text: z.string(),
});

export const ApprovalRequestedEventSchema = z.object({
  type: z.literal("approval_requested"),
  run_id: z.string(),
  plan: z.string(),
  cost: CostInfoSchema,
  refinement_round: z.number(),
});

export const PlanExecutionStartedEventSchema = z.object({
  type: z.literal("plan_execution_started"),
  run_id: z.string(),
  actor: z.string().optional(),
});

export const AgentRunCompletedEventSchema = z.object({
  type: z.literal("agent_run_completed"),
  run_id: z.string(),
  pr_url: z.string().optional(),
});

export const AgentRunFailedEventSchema = z.object({
  type: z.literal("agent_run_failed"),
  run_id: z.string(),
  message: z.string(),
});

export const AgentResponseEventSchema = z.object({
  type: z.literal("agent_response"),
  run_id: z.string(),
  text: z.string(),
  cost: CostInfoSchema.optional(),
});

export const CostUpdatedEventSchema = z.object({
  type: z.literal("cost_updated"),
  cost_total_usd: z.number(),
  turn_cost: CostInfoSchema,
});

export const PlanRevisionFrozenEventSchema = z.object({
  type: z.literal("plan_revision_frozen"),
  run_id: z.string(),
  round: z.number().int().nonnegative(),
  markdown: z.string().optional(),
  locked: z.boolean().optional(),
  created_at: z.string().optional(),
  revision_id: z.string().optional(),
});

export const AnnotationCreatedEventSchema = z.object({
  type: z.literal("annotation_created"),
  annotation: AnnotationThreadSchema,
});

export const AnnotationRepliedEventSchema = z.object({
  type: z.literal("annotation_replied"),
  thread_id: z.string(),
  reply: AnnotationReplySchema,
});

export const AnnotationWithdrawnEventSchema = z.object({
  type: z.literal("annotation_withdrawn"),
  thread_id: z.string(),
  withdrawn_by: ParticipantIdentitySchema,
  withdrawn_at: z.string(),
});

export const ConsolidationStartedEventSchema = z.object({
  type: z.literal("consolidation_started"),
  run_id: z.string(),
  round: z.number().int().nonnegative(),
});

export const BriefDispatchedEventSchema = z.object({
  type: z.literal("brief_dispatched"),
  run_id: z.string(),
  from_round: z.number().int().nonnegative(),
  to_round: z.number().int().nonnegative(),
  brief: z.string(),
});

export const AnnotationsConsumedEventSchema = z.object({
  type: z.literal("annotations_consumed"),
  run_id: z.string(),
  round: z.number().int().nonnegative(),
  thread_ids: z.array(z.string()),
});

export const QuestionRaisedEventSchema = z.object({
  type: z.literal("question_raised"),
  request_id: z.string(),
  run_id: z.string(),
  question: z.string(),
  context: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
  allow_freeform: z.boolean(),
  allow_multiple: z.boolean(),
  answerable_by: AnswerableBySchema,
  assigned_to: ParticipantIdentitySchema.optional(),
  status: z.literal("open"),
  raised_at: z.string(),
});

export const QuestionAssignedEventSchema = z.object({
  type: z.literal("question_assigned"),
  request_id: z.string(),
  assigned_to: ParticipantIdentitySchema,
  assigned_by: ParticipantIdentitySchema,
  assigned_at: z.string(),
});

export const QuestionAnsweredEventSchema = z.object({
  type: z.literal("question_answered"),
  request_id: z.string(),
  option_ids: z.array(z.string()),
  freeform: z.string().optional(),
  answered_by: ParticipantIdentitySchema,
  answered_at: z.string(),
});

export const DOToCLIEventSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema,
  StatusEventSchema,
  CloneProgressEventSchema,
  PhaseEventSchema,
  AgentEventWrapperSchema,
  PlanReadyEventSchema,
  VerificationFailedEventSchema,
  CompleteEventSchema,
  ErrorEventSchema,
  PreviewStartingEventSchema,
  PreviewReadyEventSchema,
  PreviewErrorEventSchema,
  PreviewStoppedEventSchema,
  PreviewAppsEventSchema,
  RoomReadyEventSchema,
  ParticipantJoinedEventSchema,
  ParticipantLeftEventSchema,
  HumanMessageEventSchema,
  AgentRequestEventSchema,
  AgentRequestQueuedEventSchema,
  AgentRunStartedEventSchema,
  ApprovalRequestedEventSchema,
  PlanExecutionStartedEventSchema,
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
  QuestionRaisedEventSchema,
  QuestionAssignedEventSchema,
  QuestionAnsweredEventSchema,
  CostUpdatedEventSchema,
]);

// Lenient variant for replaying persisted history from DO SQLite.
// A new deploy with stricter schemas must not crash on old log rows.
export const PersistedDOToCLIEventSchema = z
  .object({ type: z.string() })
  .passthrough();

export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;
export type StatusEvent = z.infer<typeof StatusEventSchema>;
export type CloneProgressEvent = z.infer<typeof CloneProgressEventSchema>;
export type PhaseEvent = z.infer<typeof PhaseEventSchema>;
export type AgentEventWrapper = z.infer<typeof AgentEventWrapperSchema>;
export type PlanReadyEvent = z.infer<typeof PlanReadyEventSchema>;
export type VerificationFailedEvent = z.infer<typeof VerificationFailedEventSchema>;
export type CompleteEvent = z.infer<typeof CompleteEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type PreviewStartingEvent = z.infer<typeof PreviewStartingEventSchema>;
export type PreviewReadyEvent = z.infer<typeof PreviewReadyEventSchema>;
export type PreviewErrorEvent = z.infer<typeof PreviewErrorEventSchema>;
export type PreviewStoppedEvent = z.infer<typeof PreviewStoppedEventSchema>;
export type PreviewAppsEvent = z.infer<typeof PreviewAppsEventSchema>;
export type RoomReadyEvent = z.infer<typeof RoomReadyEventSchema>;
export type ParticipantJoinedEvent = z.infer<typeof ParticipantJoinedEventSchema>;
export type ParticipantLeftEvent = z.infer<typeof ParticipantLeftEventSchema>;
export type HumanMessageEvent = z.infer<typeof HumanMessageEventSchema>;
export type AgentRequestEvent = z.infer<typeof AgentRequestEventSchema>;
export type AgentRequestQueuedEvent = z.infer<typeof AgentRequestQueuedEventSchema>;
export type AgentRunStartedEvent = z.infer<typeof AgentRunStartedEventSchema>;
export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;
export type PlanExecutionStartedEvent = z.infer<typeof PlanExecutionStartedEventSchema>;
export type AgentRunCompletedEvent = z.infer<typeof AgentRunCompletedEventSchema>;
export type AgentRunFailedEvent = z.infer<typeof AgentRunFailedEventSchema>;
export type AgentResponseEvent = z.infer<typeof AgentResponseEventSchema>;
export type CostUpdatedEvent = z.infer<typeof CostUpdatedEventSchema>;
export type PlanRevisionFrozenEvent = z.infer<typeof PlanRevisionFrozenEventSchema>;
export type AnnotationCreatedEvent = z.infer<typeof AnnotationCreatedEventSchema>;
export type AnnotationRepliedEvent = z.infer<typeof AnnotationRepliedEventSchema>;
export type AnnotationWithdrawnEvent = z.infer<typeof AnnotationWithdrawnEventSchema>;
export type ConsolidationStartedEvent = z.infer<typeof ConsolidationStartedEventSchema>;
export type BriefDispatchedEvent = z.infer<typeof BriefDispatchedEventSchema>;
export type AnnotationsConsumedEvent = z.infer<typeof AnnotationsConsumedEventSchema>;
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type AnswerableBy = z.infer<typeof AnswerableBySchema>;
export type QuestionRaisedEvent = z.infer<typeof QuestionRaisedEventSchema>;
export type QuestionAssignedEvent = z.infer<typeof QuestionAssignedEventSchema>;
export type QuestionAnsweredEvent = z.infer<typeof QuestionAnsweredEventSchema>;
export type DOToCLIEvent = z.infer<typeof DOToCLIEventSchema>;

// --- WS server frames (DO → CLI transport layer) ---
//
// The wire carries two distinct frame shapes:
//   1. EventEnvelope: { cursor: number; event: DOToCLIEvent }
//      — used for live updates and replayed tail events (unchanged)
//   2. SnapshotFrame: { type: "snapshot"; path: string; cursor: number; state: SessionSnapshot }
//      — sent at most once per WS connection, before the event tail, so late
//        joiners can hydrate from the snapshot instead of replaying from cursor 0.

export const SnapshotFrameSchema = z.object({
  type: z.literal("snapshot"),
  path: z.string(),           // 'session' today; routing key for future per-run paths
  cursor: z.number().int().nonnegative(),
  state: SessionSnapshotSchema,
});
export type SnapshotFrame = z.infer<typeof SnapshotFrameSchema>;

// ReplayBatchFrame: sent once per connection after the optional snapshot frame,
// carrying ALL tail events in a single WS frame.  Empty events array means the
// client is already up to date.  `event` is z.unknown() because events were
// validated when written — re-validation on replay is intentionally skipped.
export const ReplayBatchFrameSchema = z.object({
  type: z.literal("replay_batch"),
  events: z.array(
    z.object({
      cursor: z.number().int().nonnegative(),
      event: z.unknown(),    // server-authoritative; events validated when written
    }),
  ),
});
export type ReplayBatchFrame = z.infer<typeof ReplayBatchFrameSchema>;

// --- CLI → DO messages ---

export const ApproveMessageSchema = z.object({
  type: z.literal("approve"),
});

export const AbortMessageSchema = z.object({
  type: z.literal("abort"),
});

export const RefinePlanMessageSchema = z.object({
  type: z.literal("refine_plan"),
  feedback: z.string(),
});

export const PreviewStartMessageSchema = z.object({
  type: z.literal("preview_start"),
  app_key: z.string().optional(),
});

export const PreviewStopMessageSchema = z.object({
  type: z.literal("preview_stop"),
});

export const StopSessionMessageSchema = z.object({
  type: z.literal("stop_session"),
});

export const HumanChatMessageSchema = z.object({
  type: z.literal("human_message"),
  text: z.string().trim().min(1).max(20_000),
});

export const AgentRequestMessageSchema = z.object({
  type: z.literal("agent_request"),
  text: z.string().trim().min(1).max(20_000),
  plan_first: z.boolean().optional(),
});

export const AnnotationCreateMessageSchema = z.object({
  type: z.literal("annotation_create"),
  run_id: z.string(),
  round: z.number().int().nonnegative(),
  anchor: AnnotationAnchorSchema,
  comment: z.string().trim().min(1).max(20_000),
});

export const AnnotationReplyMessageSchema = z.object({
  type: z.literal("annotation_reply"),
  thread_id: z.string(),
  comment: z.string().trim().min(1).max(20_000),
});

export const AnnotationWithdrawMessageSchema = z.object({
  type: z.literal("annotation_withdraw"),
  thread_id: z.string(),
});

export const ApproveRunMessageSchema = z.object({
  type: z.literal("approve_run"),
  run_id: z.string(),
});

export const RefineRunMessageSchema = z.object({
  type: z.literal("refine_run"),
  run_id: z.string(),
  feedback: z.string().trim().min(1).max(20_000),
});

export const AbortRunMessageSchema = z.object({
  type: z.literal("abort_run"),
  run_id: z.string(),
});

export const QuestionAnswerMessageObjectSchema = z.object({
  type: z.literal("question_answer"),
  request_id: z.string(),
  option_ids: z.array(z.string()).optional(),
  freeform: z.string().trim().min(1).max(20_000).optional(),
});

export const QuestionAnswerMessageSchema = QuestionAnswerMessageObjectSchema.refine(
  (val) =>
    (Array.isArray(val.option_ids) && val.option_ids.length > 0) ||
    (typeof val.freeform === "string" && val.freeform.length > 0),
  { message: "question_answer must include non-empty option_ids, non-empty freeform, or both" },
);

export const QuestionAssignMessageSchema = z.object({
  type: z.literal("question_assign"),
  request_id: z.string(),
  assigned_to: ParticipantIdentitySchema,
});

const CLIToDOMessageDiscriminatedSchema = z.discriminatedUnion("type", [
  ApproveMessageSchema,
  AbortMessageSchema,
  RefinePlanMessageSchema,
  PreviewStartMessageSchema,
  PreviewStopMessageSchema,
  StopSessionMessageSchema,
  HumanChatMessageSchema,
  AgentRequestMessageSchema,
  AnnotationCreateMessageSchema,
  AnnotationReplyMessageSchema,
  AnnotationWithdrawMessageSchema,
  ApproveRunMessageSchema,
  RefineRunMessageSchema,
  AbortRunMessageSchema,
  QuestionAssignMessageSchema,
  QuestionAnswerMessageObjectSchema,
]);

export const CLIToDOMessageSchema = CLIToDOMessageDiscriminatedSchema.superRefine((val, ctx) => {
  if (val.type !== "question_answer") return;
  const hasOptions = Array.isArray(val.option_ids) && val.option_ids.length > 0;
  const hasFreeform = typeof val.freeform === "string" && val.freeform.length > 0;
  if (!hasOptions && !hasFreeform) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "question_answer must include non-empty option_ids, non-empty freeform, or both",
    });
  }
});

export type ApproveMessage = z.infer<typeof ApproveMessageSchema>;
export type AbortMessage = z.infer<typeof AbortMessageSchema>;
export type RefinePlanMessage = z.infer<typeof RefinePlanMessageSchema>;
export type PreviewStartMessage = z.infer<typeof PreviewStartMessageSchema>;
export type PreviewStopMessage = z.infer<typeof PreviewStopMessageSchema>;
export type StopSessionMessage = z.infer<typeof StopSessionMessageSchema>;
export type HumanChatMessage = z.infer<typeof HumanChatMessageSchema>;
export type AgentRequestMessage = z.infer<typeof AgentRequestMessageSchema>;
export type AnnotationCreateMessage = z.infer<typeof AnnotationCreateMessageSchema>;
export type AnnotationReplyMessage = z.infer<typeof AnnotationReplyMessageSchema>;
export type AnnotationWithdrawMessage = z.infer<typeof AnnotationWithdrawMessageSchema>;
export type ApproveRunMessage = z.infer<typeof ApproveRunMessageSchema>;
export type RefineRunMessage = z.infer<typeof RefineRunMessageSchema>;
export type AbortRunMessage = z.infer<typeof AbortRunMessageSchema>;
export type QuestionAssignMessage = z.infer<typeof QuestionAssignMessageSchema>;
export type QuestionAnswerMessage = z.infer<typeof QuestionAnswerMessageSchema>;
export type CLIToDOMessage = z.infer<typeof CLIToDOMessageSchema>;
