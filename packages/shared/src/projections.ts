/**
 * Session projection functions — pure reducers and the top-level
 * `applyToSessionSnapshot` compositor.
 *
 * These functions are shared between the web client and the Durable Object
 * worker so that both can maintain an identical in-memory SessionSnapshot by
 * applying events through the same pure logic.
 */

import type { DOToCLIEvent } from "./messages-cli.js";
import type { SessionState } from "./session.js";
import type {
  AnnotationThread,
  AnnotationReply,
} from "./annotations.js";
import type { ParticipantIdentity } from "./room.js";
import type {
  ChatMessage,
  ActivityEntry,
  PreviewState,
  PlanRevisionState,
  QuestionViewModel,
  QuestionAnswer,
} from "./projection-types.js";

export type {
  ChatMessage,
  ActivityEntry,
  PreviewState,
  PlanRevisionState,
  QuestionViewModel,
  QuestionAnswer,
} from "./projection-types.js";

// ---------------------------------------------------------------------------
// ProjectionContext
// ---------------------------------------------------------------------------

export interface ProjectionContext {
  uid: () => string;
  now: number;
}

// ---------------------------------------------------------------------------
// SessionSnapshot — the full projection state maintained per session
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  cursor: number;
  sessionPhase: SessionState | null;
  planApproved: boolean;
  messages: ChatMessage[];
  activityLog: ActivityEntry[];
  participants: ParticipantIdentity[];
  preview: PreviewState;
  planRevision: PlanRevisionState | null;
  annotations: AnnotationThread[];
  questions: QuestionViewModel[];
  selectedAnnotationId: string | null;
}

// ---------------------------------------------------------------------------
// Internal constants (mirrored from session-store.ts)
// ---------------------------------------------------------------------------

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

  // Project messages and activity log.
  const activityLog = projectActivity(snap.activityLog, event, ctx);
  const messages = projectMessages(snap.messages, event, ctx);

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

// ---------------------------------------------------------------------------
// Seven pure reducers (moved verbatim from session-store.ts)
// ---------------------------------------------------------------------------

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
      if (event.message === "Plan approved. Starting execution.") return "executing";
      if (event.message.startsWith("Verification failed")) return current === "failed" ? "failed" : "verifying";
      return null;
    default:
      return null;
  }
}

export function inferPlanApproved(event: DOToCLIEvent, current: boolean): boolean {
  if (event.type === "phase" && event.phase === "executing") return true;
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

// ---------------------------------------------------------------------------
// Messages + activity projection (moved verbatim from event-mapper.ts)
// ---------------------------------------------------------------------------

export interface ProjectedSessionView {
  messages: ChatMessage[];
  activityLog: ActivityEntry[];
}

export function mapEventToChat(event: DOToCLIEvent, ctx: ProjectionContext): ChatMessage[] {
  const ts = ctx.now;

  switch (event.type) {
    case "session_created":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Session created: ${event.session_id}`,
          timestamp: ts,
        },
      ];

    case "status":
      if (event.message === "Waiting for user approval.") return [];
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: event.message,
          timestamp: ts,
          actor: event.actor,
        },
      ];

    case "clone_progress":
      return [];

    case "phase":
      return [];

    case "plan_ready":
      return [
        {
          id: ctx.uid(),
          role: "assistant",
          variant: "plan",
          content: event.plan,
          timestamp: ts,
          meta: { cost: event.cost, refinement_round: event.refinement_round },
        },
      ];

    case "approval_requested":
      return [
        {
          id: ctx.uid(),
          role: "assistant",
          variant: "plan",
          content: event.plan,
          timestamp: ts,
          meta: {
            run_id: event.run_id,
            cost: event.cost,
            refinement_round: event.refinement_round,
          },
        },
      ];

    case "verification_failed":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "verification_failed",
          content: `Verification failed after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}.`,
          timestamp: ts,
          meta: { attempts: event.attempts, last_error: event.last_error },
        },
      ];

    case "complete":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "complete",
          content: "Session completed.",
          timestamp: ts,
          meta: { pr_url: event.pr_url },
        },
      ];

    case "error":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
          actor: event.actor,
        },
      ];

    case "preview_starting":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Starting preview: ${event.command}`,
          timestamp: ts,
        },
      ];

    case "preview_ready":
      return [];

    case "preview_error":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
        },
      ];

    case "preview_stopped":
      return [];

    case "preview_apps":
      return [];

    case "room_ready":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Room ready for ${event.repo}`,
          timestamp: ts,
        },
      ];

    case "participant_joined":
    case "participant_left":
      return [];

    case "human_message":
      return [
        {
          id: event.id,
          role: "user",
          variant: "text",
          content: event.text,
          timestamp: Date.parse(event.created_at) || ts,
          actor: event.actor.name,
          meta: { actor_id: event.actor.id },
        },
      ];

    case "agent_request":
      return [
        {
          id: event.run_id,
          role: "user",
          variant: "text",
          content: `@codevil ${event.text}`,
          timestamp: Date.parse(event.created_at) || ts,
          actor: event.actor.name,
          meta: { actor_id: event.actor.id, run_id: event.run_id },
        },
      ];

    case "agent_request_queued":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Queued agent request #${event.position}.`,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_run_started":
      return [];

    case "agent_response":
      return [
        {
          id: ctx.uid(),
          role: "assistant",
          variant: "text",
          content: event.text,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_run_completed":
      return [];

    case "agent_run_failed":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_event":
      return mapAgentEventToChat(event.event, ctx);

    case "plan_revision_frozen":
      return [];

    case "annotation_created":
      return [
        {
          id: event.annotation.id,
          role: "system",
          variant: "status",
          content: `${event.annotation.author.name} annotated the plan: ${event.annotation.comment}`,
          timestamp: Date.parse(event.annotation.created_at) || ts,
          actor: event.annotation.author.name,
          meta: { run_id: event.annotation.run_id, refinement_round: event.annotation.round },
        },
      ];

    case "annotation_replied":
      return [
        {
          id: event.reply.id,
          role: "system",
          variant: "status",
          content: `${event.reply.author.name} replied to an annotation: ${event.reply.comment}`,
          timestamp: Date.parse(event.reply.created_at) || ts,
          actor: event.reply.author.name,
        },
      ];

    case "annotation_withdrawn":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `${event.withdrawn_by.name} withdrew an annotation.`,
          timestamp: Date.parse(event.withdrawn_at) || ts,
          actor: event.withdrawn_by.name,
        },
      ];

    case "consolidation_started":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: "Consolidating plan feedback.",
          timestamp: ts,
          meta: { run_id: event.run_id, refinement_round: event.round },
        },
      ];

    case "brief_dispatched":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: "Refinement brief dispatched.",
          timestamp: ts,
          meta: { run_id: event.run_id, refinement_round: event.to_round },
        },
      ];

    case "annotations_consumed":
      return [];

    case "question_raised":
    case "question_assigned":
    case "question_answered":
      return [];
  }
}

function mapAgentEventToChat(raw: unknown, ctx: ProjectionContext): ChatMessage[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_end":
    case "message_update":
      return [];
    default:
      return [];
  }
}

export function mapEventToActivity(event: DOToCLIEvent, ctx: ProjectionContext): ActivityEntry[] {
  const ts = ctx.now;

  switch (event.type) {
    case "session_created":
      return [eventEntry("Room created", ts, ctx, event.session_id)];

    case "status":
      if (event.message === "Waiting for user approval.") return [];
      return [statusEventEntry(event.message, ts, ctx)];

    case "clone_progress":
      return [];

    case "room_ready":
      return [eventEntry("Room ready", ts, ctx, event.repo)];

    case "preview_starting":
      return [eventEntry("Preview starting", ts, ctx, event.command)];

    case "preview_ready":
      return [eventEntry("Preview ready", ts, ctx, event.url)];

    case "preview_error":
      return [eventEntry("Preview error", ts, ctx, event.message, "error")];

    case "phase":
      return [
        {
          id: ctx.uid(),
          kind: "phase_divider",
          status: "success",
          timestamp: ts,
          phase: {
            label: event.phase === "executing"
              ? `Agent turn with ${event.model}`
              : `${capitalize(event.phase)} with ${event.model}`,
          },
        },
      ];

    case "agent_event":
      return mapAgentEventToActivity(event.event, ts, ctx);

    case "agent_run_started":
      return [eventEntry("Agent run started", ts, ctx, event.text)];

    case "agent_run_completed":
      return [eventEntry("Agent finished", ts, ctx, event.pr_url)];

    case "agent_run_failed":
      return [eventEntry("Agent failed", ts, ctx, event.message, "error")];

    case "plan_revision_frozen":
      return [eventEntry("Plan revision frozen", ts, ctx, `Round ${event.round}`)];

    case "annotation_created":
      return [eventEntry("Plan annotation", ts, ctx, event.annotation.comment)];

    case "annotation_replied":
      return [eventEntry("Annotation reply", ts, ctx, event.reply.comment)];

    case "annotation_withdrawn":
      return [eventEntry("Annotation withdrawn", ts, ctx, event.thread_id)];

    case "consolidation_started":
      return [eventEntry("Consolidation started", ts, ctx, `Round ${event.round}`)];

    case "brief_dispatched":
      return [eventEntry("Brief dispatched", ts, ctx, "brief sent")];

    case "annotations_consumed":
      return [eventEntry("Annotations consumed", ts, ctx, `${event.thread_ids.length} annotations`)];

    default:
      return [];
  }
}

function mapAgentEventToActivity(raw: unknown, ts: number, ctx: ProjectionContext): ActivityEntry[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_start": {
      const name = readToolName(raw);
      return [
        {
          id: ctx.uid(),
          kind: "tool_call",
          status: "running",
          timestamp: ts,
          tool: {
            callId: readToolCallId(raw),
            name,
            summary: summarizeTool(name, raw.args),
            args: raw.args ? JSON.stringify(raw.args) : undefined,
          },
        },
      ];
    }
    case "tool_execution_end": {
      const name = readToolName(raw);
      const success = raw.success !== false && raw.isError !== true;
      const result =
        typeof raw.result === "string"
          ? raw.result
          : JSON.stringify(raw.result ?? "");
      return [
        {
          id: ctx.uid(),
          kind: "tool_call",
          status: success ? "success" : "error",
          timestamp: ts,
          tool: {
            callId: readToolCallId(raw),
            name,
            summary: summarizeTool(name, raw.args),
            result,
            error:
              !success && typeof raw.error === "string"
                ? raw.error
                : undefined,
          },
        },
      ];
    }
    case "message_update": {
      const text = readMessageDelta(raw);
      return [
        {
          id: ctx.uid(),
          kind: "thinking",
          status: "running",
          timestamp: ts,
          thinking: { text },
        },
      ];
    }
    case "agent_start":
      return [eventEntry("Agent started", ts, ctx)];
    case "agent_end":
      return [eventEntry("Agent finished", ts, ctx)];
    case "turn_start":
      return [eventEntry("Turn started", ts, ctx)];
    case "turn_end":
      return [eventEntry("Turn finished", ts, ctx, describeTurnEnd(raw))];
    default:
      return [];
  }
}

export function projectEvent(
  state: ProjectedSessionView,
  event: DOToCLIEvent,
  ctx: ProjectionContext,
): ProjectedSessionView {
  const activityLog = projectActivity(state.activityLog, event, ctx);
  return {
    messages: projectMessages(state.messages, event, ctx),
    activityLog,
  };
}

export function projectEvents(
  state: ProjectedSessionView,
  events: DOToCLIEvent[],
  ctx: ProjectionContext,
): ProjectedSessionView {
  return events.reduce((s, e) => projectEvent(s, e, ctx), state);
}

function projectMessages(messages: ChatMessage[], event: DOToCLIEvent, ctx: ProjectionContext): ChatMessage[] {
  const mapped = mapEventToChat(event, ctx);
  if (mapped.length === 0) return messages;
  return [...messages, ...mapped];
}

function projectActivity(activityLog: ActivityEntry[], event: DOToCLIEvent, ctx: ProjectionContext): ActivityEntry[] {
  if (event.type !== "agent_event") {
    const mapped = mapEventToActivity(event, ctx);
    return mapped.length === 0 ? activityLog : [...activityLog, ...mapped];
  }

  const raw = event.event;
  if (!isRecord(raw) || typeof raw.type !== "string") return activityLog;

  if (raw.type === "message_update") {
    const text = readMessageDelta(raw);
    if (!text) return activityLog;

    const last = activityLog[activityLog.length - 1];
    if (last?.kind === "thinking" && last.status === "running" && last.thinking) {
      return [
        ...activityLog.slice(0, -1),
        {
          ...last,
          timestamp: ctx.now,
          thinking: { text: last.thinking.text + text },
        },
      ];
    }

    return [
      ...activityLog,
      {
        id: ctx.uid(),
        kind: "thinking",
        status: "running",
        timestamp: ctx.now,
        thinking: { text },
      },
    ];
  }

  if (raw.type === "message_end") {
    const last = activityLog[activityLog.length - 1];
    if (last?.kind === "thinking" && last.status === "running") {
      return [
        ...activityLog.slice(0, -1),
        { ...last, status: "success", timestamp: ctx.now },
      ];
    }
    return activityLog;
  }

  if (raw.type === "tool_execution_end") {
    const name = readToolName(raw);
    const callId = readToolCallId(raw);
    const success = raw.success !== false && raw.isError !== true;
    const result =
      typeof raw.result === "string"
        ? raw.result
        : JSON.stringify(raw.result ?? "");
    const summary = summarizeTool(name, raw.args);
    const runningIndex = findRunningToolIndex(activityLog, name, summary, callId);

    if (runningIndex !== -1) {
      return activityLog.map((entry, index) =>
        index === runningIndex
          ? {
              ...entry,
              status: success ? "success" : "error",
              timestamp: ctx.now,
              tool: entry.tool
                ? {
                    ...entry.tool,
                    result,
                    error: !success && typeof raw.error === "string" ? raw.error : undefined,
                  }
                : entry.tool,
            }
          : entry,
      );
    }
  }

  const mapped = mapAgentEventToActivity(raw, ctx.now, ctx);
  return mapped.length === 0 ? activityLog : [...activityLog, ...mapped];
}

function findRunningToolIndex(
  activityLog: ActivityEntry[],
  name: string,
  summary: string,
  callId: string | undefined,
): number {
  for (let index = activityLog.length - 1; index >= 0; index--) {
    const entry = activityLog[index];
    if (callId && entry.kind === "tool_call" && entry.tool?.callId === callId) {
      return index;
    }
    if (
      entry.kind === "tool_call" &&
      entry.status === "running" &&
      entry.tool?.name === name &&
      entry.tool.summary === summary
    ) {
      return index;
    }
  }
  return -1;
}

function readToolName(raw: Record<string, unknown>): string {
  if (typeof raw.tool === "string") return raw.tool;
  if (typeof raw.toolName === "string") return raw.toolName;
  return "unknown";
}

function readToolCallId(raw: Record<string, unknown>): string | undefined {
  return typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
}

function readMessageDelta(raw: Record<string, unknown>): string {
  if (typeof raw.content === "string") return raw.content;
  const assistantEvent = raw.assistantMessageEvent;
  if (isRecord(assistantEvent) && typeof assistantEvent.delta === "string") {
    return assistantEvent.delta;
  }
  return "";
}

function eventEntry(
  label: string,
  timestamp: number,
  ctx: ProjectionContext,
  detail?: string,
  status: ActivityEntry["status"] = "success",
): ActivityEntry {
  return {
    id: ctx.uid(),
    kind: "event",
    status,
    timestamp,
    event: { label, detail },
  };
}

function classifyStatusMessage(message: string): [string, string | undefined] {
  const normalized = message.toLowerCase();
  if (normalized.includes("provision")) return ["Provisioning sandbox", message];
  if (normalized.includes("sandbox") && normalized.includes("connect")) return ["Sandbox connected", message];
  if (normalized.includes("clone") || normalized.includes("cloned")) return ["Cloned repository", message];
  if (normalized.includes("setup") && normalized.includes("complete")) return ["Setup complete", message];
  if (normalized.includes("setup") || normalized.includes("install")) return ["Running setup", message];
  if (normalized.includes("approved")) return ["Plan approved", message];
  if (normalized.includes("verification")) return ["Verification", message];
  return [message, undefined];
}

function statusEventEntry(message: string, timestamp: number, ctx: ProjectionContext): ActivityEntry {
  const [label, detail] = classifyStatusMessage(message);
  return eventEntry(label, timestamp, ctx, detail);
}

function describeTurnEnd(raw: Record<string, unknown>): string | undefined {
  const toolResults = raw.toolResults;
  if (!Array.isArray(toolResults) || toolResults.length === 0) return undefined;
  return `${toolResults.length} tool result${toolResults.length === 1 ? "" : "s"}`;
}

function summarizeTool(name: string, args: unknown): string {
  if (!isRecord(args)) return name;

  switch (name) {
    case "read":
      return typeof args.path === "string" ? `Read ${args.path}` : name;
    case "bash":
      return typeof args.command === "string" ? `Run ${args.command}` : name;
    case "edit":
      return typeof args.path === "string" ? `Edit ${args.path}` : name;
    case "write":
      return typeof args.path === "string" ? `Write ${args.path}` : name;
    case "grep":
      return typeof args.pattern === "string" ? `Search ${args.pattern}` : name;
    case "find":
      if (typeof args.pattern === "string" && typeof args.path === "string") {
        return `Find ${args.pattern} in ${args.path}`;
      }
      if (typeof args.glob === "string") return `Find ${args.glob}`;
      return name;
    case "ls":
      return typeof args.path === "string" ? `List ${args.path}` : name;
    default:
      return name;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
