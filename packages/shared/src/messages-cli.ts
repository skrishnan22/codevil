import { z } from "zod";
import { CostInfoSchema } from "./cost.js";
import { PreviewAppSchema } from "./preview.js";

// --- DO → CLI events ---

export const SessionCreatedEventSchema = z.object({
  type: z.literal("session_created"),
  session_id: z.string(),
});

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  message: z.string(),
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
export type DOToCLIEvent = z.infer<typeof DOToCLIEventSchema>;

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

export const CLIToDOMessageSchema = z.discriminatedUnion("type", [
  ApproveMessageSchema,
  AbortMessageSchema,
  RefinePlanMessageSchema,
  PreviewStartMessageSchema,
  PreviewStopMessageSchema,
  StopSessionMessageSchema,
]);

export type ApproveMessage = z.infer<typeof ApproveMessageSchema>;
export type AbortMessage = z.infer<typeof AbortMessageSchema>;
export type RefinePlanMessage = z.infer<typeof RefinePlanMessageSchema>;
export type PreviewStartMessage = z.infer<typeof PreviewStartMessageSchema>;
export type PreviewStopMessage = z.infer<typeof PreviewStopMessageSchema>;
export type StopSessionMessage = z.infer<typeof StopSessionMessageSchema>;
export type CLIToDOMessage = z.infer<typeof CLIToDOMessageSchema>;
