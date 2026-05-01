import type { CostInfo } from "./cost.js";

// --- DO → Sandbox messages ---

export interface InitMessage {
  type: "init";
  repo: string;
}

export interface PlanMessage {
  type: "plan";
  prompt: string;
  model: string;
  provider?: string;
}

export interface ExecuteMessage {
  type: "execute";
  plan: string;
  model: string;
  provider?: string;
}

export interface RefinePlanSandboxMessage {
  type: "refine_plan";
  feedback: string;
}

export interface CreatePRMessage {
  type: "create_pr";
  branch: string;
  commit_message: string;
  pr_title: string;
  pr_body: string;
}

export interface CredentialResponseMessage {
  type: "credential_response";
  token: string;
}

export type DOToSandboxMessage =
  | InitMessage
  | PlanMessage
  | ExecuteMessage
  | RefinePlanSandboxMessage
  | CreatePRMessage
  | CredentialResponseMessage;

// --- Sandbox → DO messages ---

export interface SandboxAgentEvent {
  type: "agent_event";
  event: unknown;
}

export interface SandboxCloneStarted {
  type: "clone_started";
}

export interface SandboxCloneComplete {
  type: "clone_complete";
}

export interface SandboxStatus {
  type: "status";
  message: string;
}

export interface SandboxCloneProgress {
  type: "clone_progress";
  line: string;
}

export interface SandboxPlanReady {
  type: "plan_ready";
  plan: string;
  cost: CostInfo;
}

export interface ExecutionComplete {
  type: "execution_complete";
  cost: CostInfo;
}

export interface SandboxVerificationStarted {
  type: "verification_started";
  attempt: number;
  max_attempts: number;
}

export interface SandboxVerificationRetrying {
  type: "verification_retrying";
  attempt: number;
  max_attempts: number;
  last_error: string;
}

export interface SandboxVerificationFailed {
  type: "verification_failed";
  attempts: number;
  last_error: string;
}

export interface CredentialRequest {
  type: "credential_request";
  host: string;
}

export interface PRCreated {
  type: "pr_created";
  url: string;
}

export interface SandboxError {
  type: "error";
  message: string;
}

export type SandboxToDOMessage =
  | SandboxAgentEvent
  | SandboxCloneStarted
  | SandboxCloneComplete
  | SandboxStatus
  | SandboxCloneProgress
  | SandboxPlanReady
  | ExecutionComplete
  | SandboxVerificationStarted
  | SandboxVerificationRetrying
  | SandboxVerificationFailed
  | CredentialRequest
  | PRCreated
  | SandboxError;
