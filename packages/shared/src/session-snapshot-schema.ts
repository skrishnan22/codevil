import { z } from "zod";

import { AnnotationThreadSchema } from "./annotations.js";
import { CostInfoSchema } from "./cost.js";
import { PreviewAppSchema } from "./preview.js";
import { AnswerableBySchema, QuestionOptionSchema } from "./questions.js";
import { ParticipantIdentitySchema } from "./room.js";
import { SessionStateSchema } from "./session.js";

export const ChatMessageRoleSchema = z.enum(["user", "assistant", "system"]);

export const ChatMessageVariantSchema = z.enum([
  "text",
  "status",
  "phase",
  "progress",
  "plan",
  "tool_summary",
  "complete",
  "error",
  "verification_failed",
]);

export const ChatMessageMetaSchema = z.object({
  actor_id: z.string().optional(),
  run_id: z.string().optional(),
  cost: CostInfoSchema.optional(),
  refinement_round: z.number().optional(),
  pr_url: z.string().optional(),
  attempts: z.number().optional(),
  last_error: z.string().optional(),
  phase: z.enum(["planning", "executing"]).optional(),
  model: z.string().optional(),
  tool_name: z.string().optional(),
  activity_id: z.string().optional(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: ChatMessageRoleSchema,
  variant: ChatMessageVariantSchema,
  content: z.string(),
  timestamp: z.number(),
  meta: ChatMessageMetaSchema.optional(),
  actor: z.string().optional(),
});

export const ActivityEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["tool_call", "thinking", "phase_divider", "event"]),
  status: z.enum(["running", "success", "error"]),
  timestamp: z.number(),
  tool: z.object({
    callId: z.string().optional(),
    name: z.string(),
    summary: z.string(),
    args: z.string().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
  }).optional(),
  thinking: z.object({ text: z.string() }).optional(),
  phase: z.object({ label: z.string() }).optional(),
  event: z.object({
    label: z.string(),
    detail: z.string().optional(),
  }).optional(),
});

export const PreviewStatusSchema = z.enum(["idle", "starting", "ready", "error"]);

export const PreviewStateSchema = z.object({
  status: PreviewStatusSchema,
  url: z.string().nullable(),
  command: z.string().nullable(),
  port: z.number().nullable(),
  error: z.string().nullable(),
  apps: z.array(PreviewAppSchema),
  selectedAppKey: z.string().nullable(),
  reloadRevision: z.number(),
  outputLines: z.array(z.string()),
});

export const PlanRevisionStateSchema = z.object({
  runId: z.string(),
  round: z.number().int().nonnegative(),
  markdown: z.string(),
  locked: z.boolean(),
  createdAt: z.string().nullable(),
  revisionId: z.string().nullable(),
});

export const QuestionAnswerSchema = z.object({
  optionIds: z.array(z.string()),
  freeform: z.string().optional(),
  answeredBy: ParticipantIdentitySchema,
});

export const QuestionViewModelSchema = z.object({
  requestId: z.string(),
  runId: z.string(),
  question: z.string(),
  context: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
  allowFreeform: z.boolean(),
  allowMultiple: z.boolean(),
  answerableBy: AnswerableBySchema,
  assignedTo: ParticipantIdentitySchema.optional(),
  status: z.enum(["open", "answered"]),
  raisedAt: z.number(),
  answer: QuestionAnswerSchema.optional(),
});

export const SessionSnapshotSchema = z.object({
  cursor: z.number().int().nonnegative(),
  sessionPhase: SessionStateSchema.nullable(),
  planApproved: z.boolean(),
  messages: z.array(ChatMessageSchema),
  activityLog: z.array(ActivityEntrySchema),
  participants: z.array(ParticipantIdentitySchema),
  preview: PreviewStateSchema,
  planRevision: PlanRevisionStateSchema.nullable(),
  annotations: z.array(AnnotationThreadSchema),
  questions: z.array(QuestionViewModelSchema),
  selectedAnnotationId: z.string().nullable(),
});

export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;
export type ChatMessageVariant = z.infer<typeof ChatMessageVariantSchema>;
export type ChatMessageMeta = z.infer<typeof ChatMessageMetaSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type ActivityEntryStatus = ActivityEntry["status"];
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;
export type PreviewState = z.infer<typeof PreviewStateSchema>;
export type PlanRevisionState = z.infer<typeof PlanRevisionStateSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type QuestionViewModel = z.infer<typeof QuestionViewModelSchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
