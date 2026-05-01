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
}

export interface ChatMessageMeta {
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
}

export interface NewSessionParams {
  prompt: string;
  repo: string;
  provider?: string;
  planModel?: string;
  execModel?: string;
  maxCost?: string;
  maxTime?: string;
  maxSteps?: number;
}

export interface SessionSummary {
  id: string;
  prompt: string;
  repo: string;
  state: string;
  createdAt: number;
}
