/**
 * Session projection compositor — snapshot types and the top-level
 * `applyToSessionSnapshot` entry point.
 *
 * Reducers live in `projection-reducers.ts`; chat/activity mappers in
 * `projection-chat.ts` and `projection-activity.ts`.
 */

import type { DOToCLIEvent } from "./messages-cli.js";
import type { ProjectionContext } from "./projection-types.js";
import {
  emptyPreviewState,
  inferPhase,
  inferPlanApproved,
  reducePreviewState,
  reducePlanRevision,
  reduceParticipants,
  reduceAnnotations,
  reduceQuestions,
} from "./projection-reducers.js";
import { appendProjectedChatMessages } from "./projection-chat.js";
import { appendProjectedActivity } from "./projection-activity.js";

export type {
  ChatMessage,
  ActivityEntry,
  PreviewState,
  PlanRevisionState,
  QuestionViewModel,
  QuestionAnswer,
  ProjectionContext,
} from "./projection-types.js";

export {
  emptyPreviewState,
  inferPhase,
  inferPlanApproved,
  reducePreviewState,
  reducePlanRevision,
  reduceParticipants,
  reduceAnnotations,
  parseRaisedAt,
  reduceQuestions,
} from "./projection-reducers.js";

export { mapEventToChat } from "./projection-chat.js";
export { mapEventToActivity } from "./projection-activity.js";

// ---------------------------------------------------------------------------
// SessionSnapshot — the full projection state maintained per session
// ---------------------------------------------------------------------------

export type { SessionSnapshot } from "./session-snapshot-schema.js";
import type { SessionSnapshot } from "./session-snapshot-schema.js";

export function emptySessionSnapshot(): SessionSnapshot {
  return {
    cursor: 0,
    sessionPhase: null,
    planApproved: false,
    messages: [],
    activityLog: [],
    participants: [],
    preview: { ...emptyPreviewState },
    planRevision: null,
    annotations: [],
    questions: [],
    selectedAnnotationId: null,
  };
}

// ---------------------------------------------------------------------------
// applyToSessionSnapshot — single composition entry point
// ---------------------------------------------------------------------------

/**
 * Apply one event to a SessionSnapshot, returning a new snapshot.
 * Composes all seven small reducers + the messages/activityLog projection in
 * the same order and with the same short-circuits as the old inline composition
 * in session-store.ts:244-277.
 */
export function applyToSessionSnapshot(
  snap: SessionSnapshot,
  cursor: number,
  event: DOToCLIEvent,
  ctx: ProjectionContext,
): SessionSnapshot {
  const nextPhase = inferPhase(event, snap.sessionPhase);
  const planApproved = inferPlanApproved(event, snap.planApproved);
  const preview = reducePreviewState(snap.preview, event);
  const participants = reduceParticipants(snap.participants, event);
  const planRevision = reducePlanRevision(snap.planRevision, event);

  // Reset annotations when a new revision (different run_id or round) arrives.
  const isNewRevision =
    event.type === "plan_revision_frozen" &&
    event.markdown &&
    event.markdown.length > 0 &&
    (snap.planRevision === null ||
      snap.planRevision.runId !== event.run_id ||
      snap.planRevision.round !== event.round);

  const annotationsAfterRevisionReset = isNewRevision ? [] : snap.annotations;
  const annotations = reduceAnnotations(annotationsAfterRevisionReset, event);
  const questions = reduceQuestions(snap.questions, event, ctx);

  const { messages, activityLog } = applyToChatActivity(
    { messages: snap.messages, activityLog: snap.activityLog },
    event,
    ctx,
  );

  return {
    cursor,
    sessionPhase: nextPhase ?? snap.sessionPhase,
    planApproved,
    preview,
    participants,
    planRevision,
    annotations,
    questions,
    selectedAnnotationId: isNewRevision ? null : snap.selectedAnnotationId,
    messages,
    activityLog,
  };
}

/**
 * Projects only the `messages` and `activityLog` slices of a SessionSnapshot.
 * Used by the web client's batched flush path, which has already advanced the
 * seven structural reducers per-event and only needs chat/activity recomputed.
 */
export function applyToChatActivity(
  state: Pick<SessionSnapshot, "messages" | "activityLog">,
  event: DOToCLIEvent,
  ctx: ProjectionContext,
): Pick<SessionSnapshot, "messages" | "activityLog"> {
  return {
    messages: appendProjectedChatMessages(state.messages, event, ctx),
    activityLog: appendProjectedActivity(state.activityLog, event, ctx),
  };
}
