import { create } from "zustand";
import type { SessionState, DOToCLIEvent, CLIToDOMessage } from "@codevil/shared";
import type { ChatMessage, ActivityEntry, SessionConfig, NewSessionParams } from "../types";
import { createSession } from "../lib/api-client";
import { connectWebSocket, type EventEnvelope } from "../lib/ws-client";
import { projectEvents } from "../lib/event-mapper";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

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
}

interface SessionStoreActions {
  startSession: (config: SessionConfig, params: NewSessionParams) => Promise<void>;
  connectToSession: (config: SessionConfig, sessionId: string, wsUrl: string) => void;
  approve: () => void;
  abort: () => void;
  refine: (feedback: string) => void;
  disconnect: () => void;
  addUserMessage: (content: string) => void;
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
      }),
      sessionId,
      wsUrl,
      connectionStatus: "connecting",
    });

    wsHandle = connectWebSocket({
      wsUrl,
      apiKey: config.apiKey,
      initialCursor,
      onOpen() {
        set({ connectionStatus: "connected" });
      },
      onEvent(envelope: EventEnvelope) {
        set((state) => {
          const nextPhase = inferPhase(envelope.event, state.sessionPhase);
          const planApproved = inferPlanApproved(envelope.event, state.planApproved);

          return {
            cursor: envelope.cursor,
            sessionPhase: nextPhase ?? state.sessionPhase,
            planApproved,
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
        set({ connectionStatus: "error" });
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
      return "awaiting_approval";
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
  return current;
}
