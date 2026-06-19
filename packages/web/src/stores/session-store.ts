import { create } from "zustand";
import type {
  SessionState,
  DOToCLIEvent,
  CLIToDOMessage,
  PreviewApp,
  ParticipantIdentity,
  AnnotationAnchor,
  AnnotationThread,
  AnnotationReply,
  QuestionOption,
  AnswerableBy,
} from "@codevil/shared";

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
import type { ChatMessage, ActivityEntry, SessionConfig, NewSessionParams } from "../types";
import { createSession } from "../lib/api-client";
import { connectWebSocket, type EventEnvelope } from "../lib/ws-client";
import { projectEvents, type ProjectionContext } from "../lib/event-mapper";

export interface PlanRevisionState {
  runId: string;
  round: number;
  markdown: string;
  locked: boolean;
  createdAt: string | null;
  revisionId: string | null;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
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

interface SessionStoreState {
  sessionId: string | null;
  wsUrl: string | null;
  messages: ChatMessage[];
  activityLog: ActivityEntry[];
  participants: ParticipantIdentity[];
  sessionPhase: SessionState | null;
  cursor: number;
  connectionStatus: ConnectionStatus;
  error: string | null;
  planApproved: boolean;
  preview: PreviewState;
  planRevision: PlanRevisionState | null;
  annotations: AnnotationThread[];
  questions: QuestionViewModel[];
  selectedAnnotationId: string | null;
  currentUserId: string | null;
  sessionCreatorId: string | null;
  planPanelOpen: boolean;
}

interface ConnectSessionOptions {
  sessionCreatorId?: string | null;
}

interface SessionStoreActions {
  startSession: (config: SessionConfig, params: NewSessionParams) => Promise<void>;
  connectToSession: (
    config: SessionConfig,
    sessionId: string,
    wsUrl: string,
    options?: ConnectSessionOptions,
  ) => void;
  approve: () => void;
  abort: () => void;
  refine: (feedback: string) => void;
  startPreview: () => void;
  stopPreview: () => void;
  stopSession: () => void;
  selectPreviewApp: (appKey: string) => void;
  disconnect: () => void;
  addUserMessage: (content: string) => void;
  sendRoomMessage: (content: string, options?: { planFirst?: boolean }) => void;
  sendHumanMessage: (content: string) => void;
  createAnnotation: (anchor: AnnotationAnchor, comment: string) => void;
  selectAnnotation: (id: string | null) => void;
  replyToAnnotation: (threadId: string, comment: string) => void;
  withdrawAnnotation: (threadId: string) => void;
  setCurrentUserId: (id: string | null) => void;
  setSessionCreatorId: (id: string | null) => void;
  answerQuestion: (
    requestId: string,
    answer: { optionIds: string[]; freeform?: string },
  ) => void;
  assignQuestion: (requestId: string, participant: ParticipantIdentity) => void;
  openPlanPanel: () => void;
  closePlanPanel: () => void;
  reset: () => void;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

const initialState: SessionStoreState = {
  sessionId: null,
  wsUrl: null,
  messages: [],
  activityLog: [],
  participants: [],
  sessionPhase: null,
  cursor: 0,
  connectionStatus: "disconnected",
  error: null,
  planApproved: false,
  preview: {
    status: "idle",
    url: null,
    command: null,
    port: null,
    error: null,
    apps: [],
    selectedAppKey: null,
    reloadRevision: 0,
    outputLines: [],
  },
  planRevision: null,
  annotations: [],
  questions: [],
  selectedAnnotationId: null,
  currentUserId: null,
  sessionCreatorId: null,
  planPanelOpen: false,
};

let wsHandle: { send: (msg: CLIToDOMessage) => void; close: () => void } | null = null;
let localCounter = 0;
let pendingEvents: DOToCLIEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let previewReloadTimer: ReturnType<typeof setTimeout> | null = null;
let connectionGeneration = 0;
const PREVIEW_RELOAD_DEBOUNCE_MS = 1_000;
const PREVIEW_OUTPUT_PREFIX = "Preview output: ";
const PREVIEW_OUTPUT_LIMIT = 20;

function clearPendingEvents(): void {
  pendingEvents = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function clearPreviewReloadTimer(): void {
  if (!previewReloadTimer) return;
  clearTimeout(previewReloadTimer);
  previewReloadTimer = null;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...initialState,

  async startSession(config, params) {
    set({ ...initialState, connectionStatus: "connecting" });
    try {
      const session = await createSession(config, params);
      set({ sessionId: session.session_id, wsUrl: session.ws_url });
      get().connectToSession(config, session.session_id, session.ws_url, {
        sessionCreatorId: session.summary.created_by?.id ?? null,
      });
    } catch (err) {
      set({ connectionStatus: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },

  connectToSession(config, sessionId, wsUrl, options) {
    const generation = ++connectionGeneration;
    wsHandle?.close();
    clearPendingEvents();

    const current = get();
    const isSameSession = current.sessionId === sessionId;
    const initialCursor = isSameSession ? current.cursor : 0;
    const hasCreatorIdOption = options !== undefined && "sessionCreatorId" in options;

    set({
      ...(isSameSession ? {} : {
        messages: [],
        activityLog: [],
        participants: [],
        sessionPhase: null,
        cursor: 0,
        error: null,
        planApproved: false,
        preview: initialState.preview,
        planRevision: null,
        annotations: [],
        questions: [],
        selectedAnnotationId: null,
        sessionCreatorId: hasCreatorIdOption ? options.sessionCreatorId ?? null : null,
        planPanelOpen: false,
      }),
      ...(isSameSession && hasCreatorIdOption
        ? { sessionCreatorId: options.sessionCreatorId ?? null }
        : {}),
      sessionId,
      wsUrl,
      connectionStatus: "connecting",
    });

    wsHandle = connectWebSocket({
      wsUrl,
      initialCursor,
      onOpen() {
        if (generation !== connectionGeneration) return;
        set({ connectionStatus: "connected" });
      },
      onEvent(envelope: EventEnvelope) {
        if (generation !== connectionGeneration) return;
        set((state) => {
          const nextPhase = inferPhase(envelope.event, state.sessionPhase);
          const planApproved = inferPlanApproved(envelope.event, state.planApproved);
          const preview = reducePreviewState(state.preview, envelope.event);
          const participants = reduceParticipants(state.participants, envelope.event);
          const planRevision = reducePlanRevision(state.planRevision, envelope.event);

          // Reset annotations when a new revision (different run_id or round) arrives.
          const isNewRevision =
            envelope.event.type === "plan_revision_frozen" &&
            envelope.event.markdown &&
            envelope.event.markdown.length > 0 &&
            (state.planRevision === null ||
              state.planRevision.runId !== envelope.event.run_id ||
              state.planRevision.round !== envelope.event.round);

          const annotationsAfterRevisionReset = isNewRevision ? [] : state.annotations;
          const annotations = reduceAnnotations(annotationsAfterRevisionReset, envelope.event);
          const questions = reduceQuestions(state.questions, envelope.event);

          return {
            cursor: envelope.cursor,
            sessionPhase: nextPhase ?? state.sessionPhase,
            planApproved,
            preview,
            participants,
            planRevision,
            annotations,
            questions,
            ...(isNewRevision ? { selectedAnnotationId: null } : {}),
          };
        });

        if (shouldReloadPreviewAfterEvent(envelope.event) && get().preview.status === "ready") {
          clearPreviewReloadTimer();
          previewReloadTimer = setTimeout(() => {
            previewReloadTimer = null;
            set((state) => {
              if (state.preview.status !== "ready") return {};
              return {
                preview: {
                  ...state.preview,
                  reloadRevision: state.preview.reloadRevision + 1,
                },
              };
            });
          }, PREVIEW_RELOAD_DEBOUNCE_MS);
        }

        pendingEvents.push(envelope.event);
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            const events = pendingEvents;
            pendingEvents = [];
            flushTimer = null;

            const ctx: ProjectionContext = {
              uid: () => `msg_${++localCounter}`,
              now: Date.now(),
            };
            set((state) =>
              projectEvents(
                {
                  messages: state.messages,
                  activityLog: state.activityLog,
                },
                events,
                ctx,
              ),
            );
          }, 100);
        }
      },
      onClose(_code, _reason) {
        if (generation !== connectionGeneration) return;
        set({ connectionStatus: "disconnected" });
      },
      onError() {
        // The socket close handler performs automatic reconnection.
      },
      onReconnecting() {
        if (generation !== connectionGeneration) return;
        set({ connectionStatus: "connecting" });
      },
    });
  },

  approve() {
    wsHandle?.send({ type: "approve" });
  },

  abort() {
    wsHandle?.send({ type: "abort" });
  },

  refine(feedback) {
    wsHandle?.send({ type: "refine_plan", feedback });
    // Only append a chat bubble when there is actual feedback text; the
    // "Send to agent" path with no note (empty feedback) is now common and
    // should not produce an empty bubble.
    if (feedback.trim()) {
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: `user_${Date.now()}`,
            role: "user" as const,
            variant: "text" as const,
            content: feedback,
            timestamp: Date.now(),
          },
        ],
      }));
    }
  },

  startPreview() {
    const { preview } = get();
    const appKey = preview.selectedAppKey ?? preview.apps[0]?.key;
    wsHandle?.send({ type: "preview_start", app_key: appKey });
    set((state) => ({
      preview: {
        ...state.preview,
        status: "starting",
        error: null,
        selectedAppKey: appKey ?? state.preview.selectedAppKey,
      },
    }));
  },

  stopPreview() {
    wsHandle?.send({ type: "preview_stop" });
    clearPreviewReloadTimer();
    set((state) => ({
      preview: {
        ...initialState.preview,
        apps: state.preview.apps,
        selectedAppKey: state.preview.selectedAppKey,
      },
    }));
  },

  selectPreviewApp(appKey) {
    set((state) => ({
      preview: { ...state.preview, selectedAppKey: appKey },
    }));
  },

  stopSession() {
    wsHandle?.send({ type: "stop_session" });
  },

  disconnect() {
    connectionGeneration++;
    wsHandle?.close();
    wsHandle = null;
    clearPendingEvents();
    clearPreviewReloadTimer();
    set({ connectionStatus: "disconnected" });
  },

  addUserMessage(content) {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `user_${Date.now()}`,
          role: "user" as const,
          variant: "text" as const,
          content,
          timestamp: Date.now(),
        },
      ],
    }));
  },

  sendHumanMessage(content) {
    const text = content.trim();
    if (!text) return;
    wsHandle?.send({ type: "human_message", text });
  },

  sendRoomMessage(content, options) {
    const text = content.trim();
    if (!text) return;
    const request = parseAgentMention(text);
    if (request) {
      wsHandle?.send({ type: "agent_request", text: request, ...(options?.planFirst ? { plan_first: true } : {}) });
      return;
    }
    wsHandle?.send({ type: "human_message", text });
  },

  createAnnotation(anchor, comment) {
    const planRevision = get().planRevision;
    if (!planRevision) return;
    wsHandle?.send({
      type: "annotation_create",
      run_id: planRevision.runId,
      round: planRevision.round,
      anchor,
      comment,
    });
  },

  selectAnnotation(id) {
    set({ selectedAnnotationId: id });
  },

  replyToAnnotation(threadId, comment) {
    const trimmed = comment.trim();
    if (!trimmed) return;
    wsHandle?.send({ type: "annotation_reply", thread_id: threadId, comment: trimmed });
  },

  withdrawAnnotation(threadId) {
    wsHandle?.send({ type: "annotation_withdraw", thread_id: threadId });
  },

  setCurrentUserId(id) {
    set({ currentUserId: id });
  },

  setSessionCreatorId(id) {
    set({ sessionCreatorId: id });
  },

  answerQuestion(requestId, answer) {
    const optionIds = answer.optionIds.length > 0 ? answer.optionIds : undefined;
    const freeform = answer.freeform?.trim() || undefined;
    // The server requires at least one of option_ids or freeform; no-op if neither.
    if (!optionIds && !freeform) return;
    wsHandle?.send({
      type: "question_answer",
      request_id: requestId,
      ...(optionIds ? { option_ids: optionIds } : {}),
      ...(freeform ? { freeform } : {}),
    });
  },

  assignQuestion(requestId, participant) {
    wsHandle?.send({
      type: "question_assign",
      request_id: requestId,
      assigned_to: participant,
    });
  },

  openPlanPanel() {
    set({ planPanelOpen: true });
  },

  closePlanPanel() {
    set({ planPanelOpen: false });
  },

  reset() {
    connectionGeneration++;
    wsHandle?.close();
    wsHandle = null;
    clearPendingEvents();
    clearPreviewReloadTimer();
    set(initialState);
  },
}));

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
        ...initialState.preview,
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
 * Parse an ISO `raised_at` to epoch ms, falling back to local `now` if the
 * field is missing (legacy persisted events) or unparseable.
 */
export function parseRaisedAt(raisedAt: string | undefined): number {
  if (!raisedAt) return Date.now();
  const t = Date.parse(raisedAt);
  return Number.isFinite(t) ? t : Date.now();
}

export function reduceQuestions(
  current: QuestionViewModel[],
  event: DOToCLIEvent,
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
        // relative ordering is best-effort using local clock at reduction time.
        raisedAt: parseRaisedAt(event.raised_at),
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

export function parseAgentMention(text: string): string | null {
  const match = text.trim().match(/^@codevil(?:\s+(.+))?$/i);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function shouldReloadPreviewAfterEvent(event: DOToCLIEvent): boolean {
  if (event.type !== "agent_event") return false;
  const raw = event.event;
  if (!isRecord(raw) || raw.type !== "tool_execution_end") return false;
  if (raw.success === false || raw.isError === true || typeof raw.error === "string") return false;

  const tool = typeof raw.toolName === "string"
    ? raw.toolName
    : typeof raw.tool === "string"
      ? raw.tool
      : "";
  return isWriteTool(tool);
}

function isWriteTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes("write") || normalized.includes("edit") || normalized.includes("replace");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
