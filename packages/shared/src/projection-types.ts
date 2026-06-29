/**
 * View-model types for the session projection layer.
 * Runtime shapes are defined in `session-snapshot-schema.ts`; this module
 * re-exports them so reducers and mappers share one Zod-backed source of truth.
 */

import type { ParticipantIdentity } from "./room.js";

export type {
  ChatMessageRole,
  ChatMessageMeta,
  ChatMessage,
  ActivityEntry,
  PreviewStatus,
  PreviewState,
  PlanRevisionState,
  QuestionAnswer,
  QuestionViewModel,
} from "./session-snapshot-schema.js";

/** Context passed to projection mappers (uid generator + clock). */
export interface ProjectionContext {
  uid: () => string;
  now: number;
}

export type { ParticipantIdentity };
