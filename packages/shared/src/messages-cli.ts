import type { CostInfo } from "./cost.js";

// --- DO → CLI events ---

export interface SessionCreatedEvent {
  type: "session_created";
  session_id: string;
}

export interface StatusEvent {
  type: "status";
  message: string;
}

export interface CloneProgressEvent {
  type: "clone_progress";
  line: string;
}

export interface PhaseEvent {
  type: "phase";
  phase: "planning" | "executing";
  model: string;
}

export interface AgentEventWrapper {
  type: "agent_event";
  event: unknown;
}

export interface PlanReadyEvent {
  type: "plan_ready";
  plan: string;
  cost: CostInfo;
  refinement_round: number;
}

export interface VerificationFailedEvent {
  type: "verification_failed";
  attempts: number;
  last_error: string;
}

export interface CompleteEvent {
  type: "complete";
  pr_url: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type DOToCLIEvent =
  | SessionCreatedEvent
  | StatusEvent
  | CloneProgressEvent
  | PhaseEvent
  | AgentEventWrapper
  | PlanReadyEvent
  | VerificationFailedEvent
  | CompleteEvent
  | ErrorEvent;

// --- CLI → DO messages ---

export interface ApproveMessage {
  type: "approve";
}

export interface AbortMessage {
  type: "abort";
}

export interface RefinePlanMessage {
  type: "refine_plan";
  feedback: string;
}

export type CLIToDOMessage =
  | ApproveMessage
  | AbortMessage
  | RefinePlanMessage;
