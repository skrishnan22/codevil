/**
 * View-model types for the session projection layer.
 * These types are shared between the web client and the Durable Object worker
 * so that both can maintain a SessionSnapshot using the same pure functions.
 */

import type { QuestionOption, AnswerableBy } from "./questions.js";
import type { ParticipantIdentity } from "./room.js";
import type { PreviewApp } from "./preview.js";

// ---------------------------------------------------------------------------
// Chat / conversation
// ---------------------------------------------------------------------------

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessageMeta {
  actor_id?: string;
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
  /** Display name of the teammate whose action produced this message (multiplayer attribution). */
  actor?: string;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Preview state
// ---------------------------------------------------------------------------

export type PreviewStatus = "idle" | "starting" | "ready" | "error";

export interface PreviewState {
  status: PreviewStatus;
  url: string | null;
  command: string | null;
  port: number | null;
  error: string | null;
  apps: PreviewApp[];
  selectedAppKey: string | null;
  reloadRevision: number;
  outputLines: string[];
}

// ---------------------------------------------------------------------------
// Plan revision
// ---------------------------------------------------------------------------

export interface PlanRevisionState {
  runId: string;
  round: number;
  markdown: string;
  locked: boolean;
  createdAt: string | null;
  revisionId: string | null;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface QuestionAnswer {
  optionIds: string[];
  freeform?: string;
  answeredBy: ParticipantIdentity;
}

export interface QuestionViewModel {
  requestId: string;
  runId: string;
  question: string;
  context?: string;
  options?: QuestionOption[];
  allowFreeform: boolean;
  allowMultiple: boolean;
  answerableBy: AnswerableBy;
  assignedTo?: ParticipantIdentity;
  status: "open" | "answered";
  /**
   * Client-local epoch ms at which the question is anchored in the timeline.
   * Sourced from `question_raised.raised_at` (ISO) when present; falls back to
   * `Date.now()` only for legacy persisted events emitted before the field
   * existed. See spec § "Schema change: raised_at on question_raised".
   */
  raisedAt: number;
  answer?: QuestionAnswer;
}

// Re-export so consumers don't need to import from room.ts directly.
export type { ParticipantIdentity };
