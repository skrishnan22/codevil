import type {
  AgentRunState,
  RoomState,
  SandboxState,
  SessionSummary as SharedSessionSummary,
} from "@codevil/shared";

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  variant:
    | "text"
    | "status"
    | "phase"
    | "progress"
    | "plan"
    | "tool_summary"
    | "complete"
    | "error"
    | "verification_failed";
  content: string;
  timestamp: number;
  meta?: ChatMessageMeta;
  // Display name of the teammate whose action produced this message
  // (multiplayer attribution); absent for system-generated messages.
  actor?: string;
}

export interface ChatMessageMeta {
  run_id?: string;
  cost?: { input_tokens: number; output_tokens: number; total_cost_usd: number };
  refinement_round?: number;
  pr_url?: string;
  attempts?: number;
  last_error?: string;
  phase?: "planning" | "executing";
  model?: string;
  tool_name?: string;
  activity_id?: string;
}

export type ActivityEntryStatus = "running" | "success" | "error";

export interface ActivityEntry {
  id: string;
  kind: "tool_call" | "thinking" | "phase_divider" | "event";
  status: ActivityEntryStatus;
  timestamp: number;
  tool?: {
    callId?: string;
    name: string;
    summary: string;
    args?: string;
    result?: string;
    error?: string;
  };
  thinking?: {
    text: string;
  };
  phase?: {
    label: string;
  };
  event?: {
    label: string;
    detail?: string;
  };
}

export interface SessionConfig {
  endpoint: string;
  apiKey: string;
  participantId?: string;
  // Optional self-declared display name for multiplayer attribution.
  displayName?: string;
}

export interface NewSessionParams {
  repo: string;
  provider?: string;
  planModel?: string;
  execModel?: string;
  maxCost?: string;
  maxSessionTime?: string;
  maxIdleTime?: string;
  maxSteps?: number;
}

export type SessionSummary = SharedSessionSummary;
export type { RoomState, SandboxState, AgentRunState };
