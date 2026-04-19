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
}

export interface ExecuteMessage {
  type: "execute";
  plan: string;
  model: string;
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

export interface SandboxPlanReady {
  type: "plan_ready";
  plan: string;
  cost: CostInfo;
}

export interface ExecutionComplete {
  type: "execution_complete";
  cost: CostInfo;
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
  | SandboxPlanReady
  | ExecutionComplete
  | CredentialRequest
  | PRCreated
  | SandboxError;
