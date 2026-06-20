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
import {
  applyToSessionSnapshot,
  applyToChatActivity,
  emptySessionSnapshot,
  // Re-export pure reducers so existing imports from session-store continue to work.
  inferPhase,
  inferPlanApproved,
  reducePreviewState,
  reducePlanRevision,
  reduceParticipants,
  reduceAnnotations,
  reduceQuestions,
  parseRaisedAt,
} from "@codevil/shared";
import type {
  ChatMessage,
  ActivityEntry,
  PreviewState,
  PlanRevisionState,
  QuestionViewModel,
  ProjectionContext,
  SessionSnapshot,
} from "@codevil/shared";

export {
  inferPhase,
  inferPlanApproved,
  reducePreviewState,
  reducePlanRevision,
  reduceParticipants,
  reduceAnnotations,
  reduceQuestions,
  parseRaisedAt,
};

export type {
  ChatMessage,
  ActivityEntry,
  PreviewState,
  PlanRevisionState,
  QuestionAnswer,
  QuestionViewModel,
  ProjectionContext,
  SessionSnapshot,
} from "@codevil/shared";

import type { SessionConfig, NewSessionParams } from "../types";
import { createSession } from "../lib/api-client";
import { connectWebSocket, type EventEnvelope } from "../lib/ws-client";
import type { SnapshotFrame, ReplayBatchFrame } from "@codevil/shared";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type { PreviewStatus } from "@codevil/shared";

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

const emptySnap = emptySessionSnapshot();

const initialState: SessionStoreState = {
  sessionId: null,
  wsUrl: null,
  messages: emptySnap.messages,
  activityLog: emptySnap.activityLog,
  participants: emptySnap.participants,
  sessionPhase: emptySnap.sessionPhase,
  cursor: emptySnap.cursor,
  connectionStatus: "disconnected",
  error: null,
  planApproved: emptySnap.planApproved,
  preview: emptySnap.preview,
  planRevision: emptySnap.planRevision,
  annotations: emptySnap.annotations,
  questions: emptySnap.questions,
  selectedAnnotationId: emptySnap.selectedAnnotationId,
  currentUserId: null,
  sessionCreatorId: null,
  planPanelOpen: false,
};

let wsHandle: { send: (msg: CLIToDOMessage) => void; close: () => void } | null = null;
let localCounter = 0;
let previewReloadTimer: ReturnType<typeof setTimeout> | null = null;
let connectionGeneration = 0;
const PREVIEW_RELOAD_DEBOUNCE_MS = 1_000;
const PENDING_EVENTS_DEBOUNCE_MS = 100;

// Pending events buffer for the 100 ms messages/activityLog debounce.
// Structural fields (phase, plan, preview, participants, etc.) are applied
// per-event; messages and activityLog are batched here and flushed at most
// every 100 ms to avoid a re-render per streaming token.
let pendingEvents: { cursor: number; event: DOToCLIEvent; now: number }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingEvents(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingEvents = [];
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
      onSnapshot(frame: SnapshotFrame) {
        if (generation !== connectionGeneration) return;
        // Clear any pending debounced events — the snapshot is the ground truth.
        clearPendingEvents();
        const snap = frame.state as SessionSnapshot;
        set((state) => ({
          cursor: frame.cursor,
          sessionPhase: snap.sessionPhase,
          planApproved: snap.planApproved,
          messages: snap.messages,
          activityLog: snap.activityLog,
          participants: snap.participants,
          preview: snap.preview,
          planRevision: snap.planRevision,
          annotations: snap.annotations,
          questions: snap.questions,
          selectedAnnotationId: snap.selectedAnnotationId,
        }));
      },
      onReplayBatch(frame: ReplayBatchFrame) {
        if (generation !== connectionGeneration) return;
        // Intentionally bypasses the 100 ms pendingEvents debounce: a replay
        // batch is a one-shot bulk delivery, not a live token-streaming burst.
        // All events are reduced in a single set() call for immediate rendering.
        const batchNow = Date.now();
        set((state) => {
          let snap: SessionSnapshot = {
            cursor: state.cursor,
            sessionPhase: state.sessionPhase,
            planApproved: state.planApproved,
            messages: state.messages,
            activityLog: state.activityLog,
            participants: state.participants,
            preview: state.preview,
            planRevision: state.planRevision,
            annotations: state.annotations,
            questions: state.questions,
            selectedAnnotationId: state.selectedAnnotationId,
          };
          for (let i = 0; i < frame.events.length; i++) {
            const item = frame.events[i];
            const ctx: ProjectionContext = {
              uid: () => `msg_${++localCounter}`,
              // +i gives each event a monotonically-increasing timestamp within
              // the batch (1 ms ticks) so timeline ordering is preserved for
              // events that are ordered purely by ctx.now (e.g. session_created,
              // status).  This avoids identical timestamps without introducing
              // per-iteration Date.now() calls.
              now: batchNow + i,
            };
            snap = applyToSessionSnapshot(snap, item.cursor, item.event as DOToCLIEvent, ctx);
          }
          return {
            cursor: snap.cursor,
            sessionPhase: snap.sessionPhase,
            planApproved: snap.planApproved,
            messages: snap.messages,
            activityLog: snap.activityLog,
            participants: snap.participants,
            preview: snap.preview,
            planRevision: snap.planRevision,
            annotations: snap.annotations,
            questions: snap.questions,
            selectedAnnotationId: snap.selectedAnnotationId,
          };
        });
      },
      onEvent(envelope: EventEnvelope) {
        if (generation !== connectionGeneration) return;

        const now = Date.now();
        const ctx = {
          uid: () => `msg_${++localCounter}`,
          now,
        };

        // Apply structural (non-streaming) fields immediately so the UI
        // responds to phase changes, plan updates, etc. without waiting for
        // the 100 ms debounce.  messages and activityLog are intentionally
        // excluded here — they are batched below.
        set((state) => {
          const currentSnap = {
            cursor: state.cursor,
            sessionPhase: state.sessionPhase,
            planApproved: state.planApproved,
            messages: state.messages,
            activityLog: state.activityLog,
            participants: state.participants,
            preview: state.preview,
            planRevision: state.planRevision,
            annotations: state.annotations,
            questions: state.questions,
            selectedAnnotationId: state.selectedAnnotationId,
          };

          const next = applyToSessionSnapshot(currentSnap, envelope.cursor, envelope.event, ctx);

          // Only update the structural (non-message) fields immediately.
          return {
            cursor: next.cursor,
            sessionPhase: next.sessionPhase,
            planApproved: next.planApproved,
            participants: next.participants,
            preview: next.preview,
            planRevision: next.planRevision,
            annotations: next.annotations,
            questions: next.questions,
            selectedAnnotationId: next.selectedAnnotationId,
          };
        });

        // Enqueue the event for the batched messages/activityLog flush.
        pendingEvents.push({ cursor: envelope.cursor, event: envelope.event, now });

        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            const batch = pendingEvents;
            pendingEvents = [];

            set((state) => {
              let messages = state.messages;
              let activityLog = state.activityLog;

              for (const pending of batch) {
                const batchCtx = {
                  uid: () => `msg_${++localCounter}`,
                  now: pending.now,
                };
                const next = applyToChatActivity(
                  { messages, activityLog },
                  pending.event,
                  batchCtx,
                );
                messages = next.messages;
                activityLog = next.activityLog;
              }

              return { messages, activityLog };
            });
          }, PENDING_EVENTS_DEBOUNCE_MS);
        }

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
