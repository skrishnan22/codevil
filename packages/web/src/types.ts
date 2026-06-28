import type {
  AgentRunState,
  RoomState,
  SandboxState,
  SessionSummary as SharedSessionSummary,
} from "@codevil/shared";

export type {
  ChatMessageRole,
  ChatMessageMeta,
  ChatMessage,
  ActivityEntryStatus,
  ActivityEntry,
} from "@codevil/shared";

export interface SessionConfig {
  endpoint: string;
}

export interface NewSessionParams {
  repo: string;
  provider?: string;
  planModel?: string;
  execModel?: string;
  maxSessionTime?: string;
  maxIdleTime?: string;
}

export type SessionSummary = SharedSessionSummary;
export type { RoomState, SandboxState, AgentRunState };
