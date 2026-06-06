import { z } from "zod";
import { CostInfoSchema } from "./cost.js";
import { PreviewAppSchema } from "./preview.js";

// --- DO → Sandbox messages ---

export const InitMessageSchema = z.object({
  type: z.literal("init"),
  repo: z.string(),
  trace_id: z.string().optional(),
});

// Trace propagation: phase-starting messages may carry the DO-side parent
// span context so the sandbox can nest its child spans under the phase.
const TraceContextFields = {
  trace_id: z.string().optional(),
  parent_span_id: z.string().optional(),
};

export const PlanMessageSchema = z.object({
  type: z.literal("plan"),
  prompt: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  ...TraceContextFields,
});

export const AgentTurnMessageSchema = z.object({
  type: z.literal("agent_turn"),
  run_id: z.string(),
  prompt: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  ...TraceContextFields,
});

export const ExecuteMessageSchema = z.object({
  type: z.literal("execute"),
  plan: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  ...TraceContextFields,
});

export const RefinePlanSandboxMessageSchema = z.object({
  type: z.literal("refine_plan"),
  feedback: z.string(),
  ...TraceContextFields,
});

export const CreatePRMessageSchema = z.object({
  type: z.literal("create_pr"),
  branch: z.string(),
  commit_message: z.string(),
  pr_title: z.string(),
  pr_body: z.string(),
  ...TraceContextFields,
});

export const CredentialResponseMessageSchema = z.object({
  type: z.literal("credential_response"),
  request_id: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
  error: z.string().optional(),
});

export const CreatePRResponseMessageSchema = z.object({
  type: z.literal("create_pr_response"),
  request_id: z.string(),
  url: z.string().optional(),
  error: z.string().optional(),
});

export const PreviewStartSandboxMessageSchema = z.object({
  type: z.literal("preview_start"),
  model: z.string().optional(),
  provider: z.string().optional(),
  task_prompt: z.string().optional(),
  app_key: z.string().optional(),
  ...TraceContextFields,
});

export const PreviewStopSandboxMessageSchema = z.object({
  type: z.literal("preview_stop"),
});

export const DOToSandboxMessageSchema = z.discriminatedUnion("type", [
  InitMessageSchema,
  AgentTurnMessageSchema,
  PlanMessageSchema,
  ExecuteMessageSchema,
  RefinePlanSandboxMessageSchema,
  CreatePRMessageSchema,
  CredentialResponseMessageSchema,
  CreatePRResponseMessageSchema,
  PreviewStartSandboxMessageSchema,
  PreviewStopSandboxMessageSchema,
]);

export type InitMessage = z.infer<typeof InitMessageSchema>;
export type AgentTurnMessage = z.infer<typeof AgentTurnMessageSchema>;
export type PlanMessage = z.infer<typeof PlanMessageSchema>;
export type ExecuteMessage = z.infer<typeof ExecuteMessageSchema>;
export type RefinePlanSandboxMessage = z.infer<typeof RefinePlanSandboxMessageSchema>;
export type CreatePRMessage = z.infer<typeof CreatePRMessageSchema>;
export type CredentialResponseMessage = z.infer<typeof CredentialResponseMessageSchema>;
export type CreatePRResponseMessage = z.infer<typeof CreatePRResponseMessageSchema>;
export type PreviewStartSandboxMessage = z.infer<typeof PreviewStartSandboxMessageSchema>;
export type PreviewStopSandboxMessage = z.infer<typeof PreviewStopSandboxMessageSchema>;
export type DOToSandboxMessage = z.infer<typeof DOToSandboxMessageSchema>;

// --- Sandbox → DO messages ---

// AgentEvent payload is validated separately by Pi event schemas before
// being wrapped. Here it's opaque to keep the wire decoupled from Pi versions.
export const SandboxAgentEventSchema = z.object({
  type: z.literal("agent_event"),
  event: z.unknown(),
});

export const SandboxCloneStartedSchema = z.object({
  type: z.literal("clone_started"),
});

export const SandboxCloneCompleteSchema = z.object({
  type: z.literal("clone_complete"),
});

export const SandboxStatusSchema = z.object({
  type: z.literal("status"),
  message: z.string(),
});

export const SandboxCloneProgressSchema = z.object({
  type: z.literal("clone_progress"),
  line: z.string(),
});

export const SandboxPlanReadySchema = z.object({
  type: z.literal("plan_ready"),
  plan: z.string(),
  cost: CostInfoSchema,
});

export const AgentTurnCompleteSchema = z.object({
  type: z.literal("agent_turn_complete"),
  run_id: z.string(),
  response: z.string(),
  cost: CostInfoSchema,
});

export const CreatePRRequestSchema = z.object({
  type: z.literal("create_pr_request"),
  run_id: z.string(),
  request_id: z.string(),
  branch: z.string(),
  base_branch: z.string(),
  title: z.string(),
  body: z.string(),
  draft: z.boolean(),
});

export const ExecutionCompleteSchema = z.object({
  type: z.literal("execution_complete"),
  cost: CostInfoSchema,
});

export const SandboxVerificationStartedSchema = z.object({
  type: z.literal("verification_started"),
  attempt: z.number(),
  max_attempts: z.number(),
});

export const SandboxVerificationRetryingSchema = z.object({
  type: z.literal("verification_retrying"),
  attempt: z.number(),
  max_attempts: z.number(),
  last_error: z.string(),
});

export const SandboxVerificationFailedSchema = z.object({
  type: z.literal("verification_failed"),
  attempts: z.number(),
  last_error: z.string(),
});

export const CredentialRequestSchema = z.object({
  type: z.literal("credential_request"),
  request_id: z.string(),
  protocol: z.literal("https"),
  host: z.string(),
  path: z.string().optional(),
});

export const BranchPushedSchema = z.object({
  type: z.literal("branch_pushed"),
  branch: z.string(),
  base_branch: z.string(),
  pr_title: z.string(),
  pr_body: z.string(),
});

export const PRCreatedSchema = z.object({
  type: z.literal("pr_created"),
  url: z.string(),
});

export const SandboxErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const SandboxPreviewStartingSchema = z.object({
  type: z.literal("preview_starting"),
  command: z.string(),
  port: z.number(),
});

export const SandboxPreviewReadySchema = z.object({
  type: z.literal("preview_ready"),
  command: z.string(),
  port: z.number(),
});

export const SandboxPreviewErrorSchema = z.object({
  type: z.literal("preview_error"),
  message: z.string(),
});

export const SandboxPreviewStoppedSchema = z.object({
  type: z.literal("preview_stopped"),
});

export const SandboxPreviewAppsSchema = z.object({
  type: z.literal("preview_apps"),
  apps: z.array(PreviewAppSchema),
});

export const SandboxToDOMessageSchema = z.discriminatedUnion("type", [
  SandboxAgentEventSchema,
  SandboxCloneStartedSchema,
  SandboxCloneCompleteSchema,
  SandboxStatusSchema,
  SandboxCloneProgressSchema,
  SandboxPlanReadySchema,
  AgentTurnCompleteSchema,
  CreatePRRequestSchema,
  ExecutionCompleteSchema,
  SandboxVerificationStartedSchema,
  SandboxVerificationRetryingSchema,
  SandboxVerificationFailedSchema,
  CredentialRequestSchema,
  BranchPushedSchema,
  PRCreatedSchema,
  SandboxErrorSchema,
  SandboxPreviewStartingSchema,
  SandboxPreviewReadySchema,
  SandboxPreviewErrorSchema,
  SandboxPreviewStoppedSchema,
  SandboxPreviewAppsSchema,
]);

export type SandboxAgentEvent = z.infer<typeof SandboxAgentEventSchema>;
export type SandboxCloneStarted = z.infer<typeof SandboxCloneStartedSchema>;
export type SandboxCloneComplete = z.infer<typeof SandboxCloneCompleteSchema>;
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;
export type SandboxCloneProgress = z.infer<typeof SandboxCloneProgressSchema>;
export type SandboxPlanReady = z.infer<typeof SandboxPlanReadySchema>;
export type AgentTurnComplete = z.infer<typeof AgentTurnCompleteSchema>;
export type CreatePRRequest = z.infer<typeof CreatePRRequestSchema>;
export type ExecutionComplete = z.infer<typeof ExecutionCompleteSchema>;
export type SandboxVerificationStarted = z.infer<typeof SandboxVerificationStartedSchema>;
export type SandboxVerificationRetrying = z.infer<typeof SandboxVerificationRetryingSchema>;
export type SandboxVerificationFailed = z.infer<typeof SandboxVerificationFailedSchema>;
export type CredentialRequest = z.infer<typeof CredentialRequestSchema>;
export type BranchPushed = z.infer<typeof BranchPushedSchema>;
export type PRCreated = z.infer<typeof PRCreatedSchema>;
export type SandboxError = z.infer<typeof SandboxErrorSchema>;
export type SandboxPreviewStarting = z.infer<typeof SandboxPreviewStartingSchema>;
export type SandboxPreviewReady = z.infer<typeof SandboxPreviewReadySchema>;
export type SandboxPreviewError = z.infer<typeof SandboxPreviewErrorSchema>;
export type SandboxPreviewStopped = z.infer<typeof SandboxPreviewStoppedSchema>;
export type SandboxPreviewApps = z.infer<typeof SandboxPreviewAppsSchema>;
export type SandboxToDOMessage = z.infer<typeof SandboxToDOMessageSchema>;
