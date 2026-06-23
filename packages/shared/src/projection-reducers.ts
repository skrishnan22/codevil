/**
 * Structural reducers for session snapshot fields (phase, preview, participants, etc.)
 */

import type { DOToCLIEvent } from "./messages-cli.js";
import type { SessionState } from "./session.js";
import type { AnnotationThread, AnnotationReply } from "./annotations.js";
import type { ParticipantIdentity } from "./room.js";
import type {
  PreviewState,
  PlanRevisionState,
  QuestionViewModel,
  ProjectionContext,
} from "./projection-types.js";

const PREVIEW_OUTPUT_PREFIX = "Preview output: ";
const PREVIEW_OUTPUT_LIMIT = 20;

export const emptyPreviewState: PreviewState = {
  status: "idle",
  url: null,
  command: null,
  port: null,
  error: null,
  apps: [],
  selectedAppKey: null,
  reloadRevision: 0,
  outputLines: [],
};
export function inferPhase(
  event: DOToCLIEvent,
  current: SessionState | null,
): SessionState | null {
  switch (event.type) {
    case "session_created":
      return "initializing";
    case "phase":
      return event.phase === "planning" ? "planning" : "executing";
    case "plan_ready":
    case "approval_requested":
      return "awaiting_approval";
    case "brief_dispatched":
      return "refining";
    case "agent_run_started":
      return "executing";
    case "plan_execution_started":
      return "executing";
    case "agent_run_completed":
      return "ready";
    case "agent_run_failed":
      return "ready";
    case "complete":
      return "completed";
    case "verification_failed":
      return "failed";
    case "error":
      return "failed";
    case "status":
      // Legacy replay: older sessions emitted plan approval as a status message.
      if (event.message === "Plan approved. Starting execution.") return "executing";
      if (event.message.startsWith("Verification failed")) return current === "failed" ? "failed" : "verifying";
      return null;
    default:
      return null;
  }
}

export function inferPlanApproved(event: DOToCLIEvent, current: boolean): boolean {
  if (event.type === "phase" && event.phase === "executing") return true;
  if (event.type === "plan_execution_started") return true;
  // Legacy replay: older sessions emitted plan approval as a status message.
  if (event.type === "status" && event.message === "Plan approved. Starting execution.") return true;
  if (event.type === "agent_run_started" || event.type === "approval_requested") return false;
  return current;
}

export function reducePreviewState(current: PreviewState, event: DOToCLIEvent): PreviewState {
  switch (event.type) {
    case "preview_starting":
      return {
        ...current,
        status: "starting",
        url: null,
        command: event.command,
        port: event.port,
        error: null,
        outputLines: [],
      };
    case "preview_ready":
      return {
        ...current,
        status: "ready",
        url: event.url,
        command: event.command,
        port: event.port,
        error: null,
      };
    case "preview_error":
      return {
        ...current,
        status: "error",
        url: null,
        error: event.message,
      };
    case "status": {
      if (!event.message.startsWith(PREVIEW_OUTPUT_PREFIX)) return current;
      const line = event.message.slice(PREVIEW_OUTPUT_PREFIX.length).trim();
      if (!line) return current;
      return {
        ...current,
        outputLines: [...current.outputLines, line].slice(-PREVIEW_OUTPUT_LIMIT),
      };
    }
    case "preview_stopped":
      return {
        ...emptyPreviewState,
        apps: current.apps,
        selectedAppKey: current.selectedAppKey,
      };
    case "preview_apps": {
      const apps = event.apps;
      const stillValid = current.selectedAppKey && apps.some((app) => app.key === current.selectedAppKey);
      return {
        ...current,
        apps,
        selectedAppKey: stillValid ? current.selectedAppKey : apps[0]?.key ?? null,
      };
    }
    default:
      return current;
  }
}

export function reducePlanRevision(
  current: PlanRevisionState | null,
  event: DOToCLIEvent,
): PlanRevisionState | null {
  if (event.type !== "plan_revision_frozen") return current;

  const { run_id, round, markdown, locked, created_at, revision_id } = event;

  if (markdown && markdown.length > 0) {
    // Full revision with new markdown content
    return {
      runId: run_id,
      round,
      markdown,
      locked: locked ?? false,
      createdAt: created_at ?? null,
      revisionId: revision_id ?? null,
    };
  }

  // Lock-only signal (no markdown) — update locked on existing revision if present
  if (current !== null) {
    return {
      ...current,
      locked: locked ?? current.locked,
    };
  }

  return current;
}

export function reduceParticipants(
  current: ParticipantIdentity[],
  event: DOToCLIEvent,
): ParticipantIdentity[] {
  switch (event.type) {
    case "participant_joined":
      return upsertParticipant(current, event.participant);
    case "participant_left":
      return current.filter((participant) => participant.id !== event.participant.id);
    default:
      return current;
  }
}

function upsertParticipant(
  current: ParticipantIdentity[],
  participant: ParticipantIdentity,
): ParticipantIdentity[] {
  const existingIndex = current.findIndex((item) => item.id === participant.id);
  if (existingIndex === -1) return [...current, participant];
  return current.map((item, index) => index === existingIndex ? participant : item);
}

export function reduceAnnotations(
  current: AnnotationThread[],
  event: DOToCLIEvent,
): AnnotationThread[] {
  switch (event.type) {
    case "annotation_created": {
      const annotation = event.annotation;
      // Dedupe by id — ignore if already present.
      if (current.some((t) => t.id === annotation.id)) return current;
      return [...current, annotation];
    }
    case "annotation_replied": {
      const { thread_id, reply } = event;
      const index = current.findIndex((t) => t.id === thread_id);
      // Unknown thread — unchanged.
      if (index === -1) return current;
      const thread = current[index];
      const existingReplies: AnnotationReply[] = thread.replies ?? [];
      // Dedupe replies by id.
      if (existingReplies.some((r) => r.id === reply.id)) return current;
      const updatedThread: AnnotationThread = {
        ...thread,
        replies: [...existingReplies, reply],
      };
      return current.map((t, i) => (i === index ? updatedThread : t));
    }
    case "annotation_withdrawn": {
      const { thread_id } = event;
      const index = current.findIndex((t) => t.id === thread_id);
      // Unknown thread — unchanged.
      if (index === -1) return current;
      if (current[index].status === "withdrawn") return current;
      return current.map((t, i) =>
        i === index ? { ...t, status: "withdrawn" as const } : t,
      );
    }
    case "annotations_consumed": {
      const { thread_ids } = event;
      if (thread_ids.length === 0) return current;
      const idSet = new Set(thread_ids);
      let changed = false;
      const next = current.map((t) => {
        if (idSet.has(t.id) && t.status !== "consumed") {
          changed = true;
          return { ...t, status: "consumed" as const };
        }
        return t;
      });
      return changed ? next : current;
    }
    default:
      return current;
  }
}

/**
 * Parse an ISO `raised_at` to epoch ms, falling back to `fallback` if the
 * field is missing (legacy persisted events) or unparseable.
 */
export function parseRaisedAt(raisedAt: string | undefined, fallback: number): number {
  if (!raisedAt) return fallback;
  const t = Date.parse(raisedAt);
  return Number.isFinite(t) ? t : fallback;
}

export function reduceQuestions(
  current: QuestionViewModel[],
  event: DOToCLIEvent,
  ctx: ProjectionContext,
): QuestionViewModel[] {
  switch (event.type) {
    case "question_raised": {
      // Dedupe by request_id
      if (current.some((q) => q.requestId === event.request_id)) return current;
      const viewModel: QuestionViewModel = {
        requestId: event.request_id,
        runId: event.run_id,
        question: event.question,
        context: event.context,
        options: event.options,
        allowFreeform: event.allow_freeform,
        allowMultiple: event.allow_multiple,
        answerableBy: event.answerable_by,
        assignedTo: event.assigned_to,
        status: "open",
        // Legacy persisted events (pre-schema-update) lack raised_at; their
        // relative ordering is best-effort using ctx.now at reduction time.
        raisedAt: parseRaisedAt(event.raised_at, ctx.now),
      };
      return [...current, viewModel];
    }
    case "question_assigned": {
      const index = current.findIndex((q) => q.requestId === event.request_id);
      if (index === -1) return current;
      return current.map((q, i) =>
        i === index
          ? {
              ...q,
              answerableBy: "assigned" as const,
              assignedTo: event.assigned_to,
            }
          : q,
      );
    }
    case "question_answered": {
      const index = current.findIndex((q) => q.requestId === event.request_id);
      if (index === -1) return current;
      if (current[index].status === "answered") return current;
      return current.map((q, i) =>
        i === index
          ? {
              ...q,
              status: "answered" as const,
              answer: {
                optionIds: event.option_ids,
                freeform: event.freeform,
                answeredBy: event.answered_by,
              },
            }
          : q,
      );
    }
    default:
      return current;
  }
}
