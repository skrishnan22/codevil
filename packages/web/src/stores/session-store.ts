import { create } from "zustand";
import type { SessionState, DOToCLIEvent, CLIToDOMessage, PreviewApp } from "@codevil/shared";
import type { ChatMessage, ActivityEntry, SessionConfig, NewSessionParams } from "../types";
import { createSession } from "../lib/api-client";
import { connectWebSocket, type EventEnvelope } from "../lib/ws-client";
import { projectEvents } from "../lib/event-mapper";

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
}

interface SessionStoreState {
  sessionId: string | null;
  wsUrl: string | null;
  messages: ChatMessage[];
  activityLog: ActivityEntry[];
  sessionPhase: SessionState | null;
  cursor: number;
  connectionStatus: ConnectionStatus;
  error: string | null;
  planApproved: boolean;
  preview: PreviewState;
}

interface SessionStoreActions {
  startSession: (config: SessionConfig, params: NewSessionParams) => Promise<void>;
  connectToSession: (config: SessionConfig, sessionId: string, wsUrl: string) => void;
  approve: () => void;
  abort: () => void;
  refine: (feedback: string) => void;
  startPreview: () => void;
  stopPreview: () => void;
  stopSession: () => void;
  selectPreviewApp: (appKey: string) => void;
  disconnect: () => void;
  addUserMessage: (content: string) => void;
  sendRoomMessage: (content: string) => void;
  sendHumanMessage: (content: string) => void;
  reset: () => void;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

const initialState: SessionStoreState = {
  sessionId: null,
  wsUrl: null,
  messages: [],
  activityLog: [],
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
  },
};

let wsHandle: { send: (msg: CLIToDOMessage) => void; close: () => void } | null = null;
let pendingEvents: DOToCLIEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingEvents(): void {
  pendingEvents = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...initialState,

  async startSession(config, params) {
    set({ ...initialState, connectionStatus: "connecting" });
    try {
      const session = await createSession(config, params);
      set({ sessionId: session.session_id, wsUrl: session.ws_url });
      get().connectToSession(config, session.session_id, session.ws_url);
    } catch (err) {
      set({ connectionStatus: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },

  connectToSession(config, sessionId, wsUrl) {
    wsHandle?.close();
    clearPendingEvents();

    const current = get();
    const isSameSession = current.sessionId === sessionId;
    const initialCursor = isSameSession ? current.cursor : 0;

    set({
      ...(isSameSession ? {} : {
        messages: [],
        activityLog: [],
        sessionPhase: null,
        cursor: 0,
        error: null,
        planApproved: false,
        preview: initialState.preview,
      }),
      sessionId,
      wsUrl,
      connectionStatus: "connecting",
    });

    wsHandle = connectWebSocket({
      wsUrl,
      apiKey: config.apiKey,
      initialCursor,
      displayName: config.displayName,
      participantId: config.participantId,
      onOpen() {
        set({ connectionStatus: "connected" });
      },
      onEvent(envelope: EventEnvelope) {
        set((state) => {
          const nextPhase = inferPhase(envelope.event, state.sessionPhase);
          const planApproved = inferPlanApproved(envelope.event, state.planApproved);
          const preview = reducePreviewState(state.preview, envelope.event);

          return {
            cursor: envelope.cursor,
            sessionPhase: nextPhase ?? state.sessionPhase,
            planApproved,
            preview,
          };
        });

        pendingEvents.push(envelope.event);
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            const events = pendingEvents;
            pendingEvents = [];
            flushTimer = null;

            set((state) =>
              projectEvents(
                {
                  messages: state.messages,
                  activityLog: state.activityLog,
                },
                events,
              ),
            );
          }, 100);
        }
      },
      onClose(_code, _reason) {
        set({ connectionStatus: "disconnected" });
      },
      onError() {
        // The socket close handler performs automatic reconnection.
      },
      onReconnecting() {
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
    wsHandle?.close();
    wsHandle = null;
    clearPendingEvents();
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

  sendRoomMessage(content) {
    const text = content.trim();
    if (!text) return;
    const request = parseAgentMention(text);
    if (request) {
      wsHandle?.send({ type: "agent_request", text: request });
      return;
    }
    wsHandle?.send({ type: "human_message", text });
  },

  reset() {
    wsHandle?.close();
    wsHandle = null;
    clearPendingEvents();
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

export function parseAgentMention(text: string): string | null {
  const match = text.trim().match(/^@codevil(?:\s+(.+))?$/i);
  if (!match) return null;
  return match[1]?.trim() || null;
}
