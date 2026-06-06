import { afterEach, describe, expect, it } from "vitest";
import { inferPhase, inferPlanApproved, reducePreviewState, useSessionStore } from "../session-store";

describe("session event state inference", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
  });

  it("marks a plan approved from the worker approval status", () => {
    expect(inferPlanApproved({ type: "status", message: "Plan approved. Starting execution." }, false)).toBe(true);
  });

  it("moves verification failure into failed phase", () => {
    expect(
      inferPhase(
        { type: "verification_failed", attempts: 5, last_error: "tests failed" },
        "awaiting_approval",
      ),
    ).toBe("failed");
  });

  it("starts general agent requests in the executing phase", () => {
    expect(inferPhase({
      type: "agent_run_started",
      run_id: "run_123",
      actor: { id: "usr_123", name: "Alice" },
      text: "explain auth",
    }, "ready")).toBe("executing");
  });

  it("tracks preview readiness and stop events", () => {
    const idle = { status: "idle" as const, url: null, command: null, port: null, error: null, apps: [], selectedAppKey: null };
    const starting = reducePreviewState(
      idle,
      { type: "preview_starting", command: "pnpm dev -- --host 0.0.0.0", port: 5173 },
    );
    expect(starting.status).toBe("starting");
    expect(starting.command).toBe("pnpm dev -- --host 0.0.0.0");
    expect(starting.port).toBe(5173);

    const ready = reducePreviewState(starting, {
      type: "preview_ready",
      url: "https://preview.example/",
      command: "pnpm dev -- --host 0.0.0.0",
      port: 5173,
    });
    expect(ready.status).toBe("ready");
    expect(ready.url).toBe("https://preview.example/");

    expect(reducePreviewState(ready, { type: "preview_stopped" }).status).toBe("idle");
  });

  it("captures preview apps and defaults the selected app to the first entry", () => {
    const idle = { status: "idle" as const, url: null, command: null, port: null, error: null, apps: [], selectedAppKey: null };
    const withApps = reducePreviewState(idle, {
      type: "preview_apps",
      apps: [
        { key: "apps/web", name: "web", cwd: "/workspace/repo/apps/web", framework: "next", command: "npm run dev -- --hostname 0.0.0.0 --port 3001", port: 3001 },
        { key: "apps/landing", name: "landing", cwd: "/workspace/repo/apps/landing", framework: "next", command: "npm run dev -- --hostname 0.0.0.0 --port 3001", port: 3001 },
      ],
    });
    expect(withApps.apps.length).toBe(2);
    expect(withApps.selectedAppKey).toBe("apps/web");
  });

  it("keeps the user's selection when refreshing the app list", () => {
    const apps = [
      { key: "apps/web", name: "web", cwd: "/workspace/repo/apps/web", framework: "next" as const, command: "npm run dev", port: 3001 },
      { key: "apps/landing", name: "landing", cwd: "/workspace/repo/apps/landing", framework: "next" as const, command: "npm run dev", port: 3001 },
    ];
    const selected = {
      status: "idle" as const,
      url: null,
      command: null,
      port: null,
      error: null,
      apps,
      selectedAppKey: "apps/landing",
    };
    const refreshed = reducePreviewState(selected, { type: "preview_apps", apps });
    expect(refreshed.selectedAppKey).toBe("apps/landing");
  });

  it("resets stale state when connecting to a different session", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      url: string;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }

      send() {}
      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    try {
      useSessionStore.setState({
        sessionId: "ses_old",
        messages: [{
          id: "old",
          role: "assistant",
          variant: "text",
          content: "old plan",
          timestamp: 1,
        }],
        activityLog: [{
          id: "old-activity",
          kind: "event",
          status: "success",
          timestamp: 1,
          event: { label: "old activity" },
        }],
        cursor: 8,
        sessionPhase: "awaiting_approval",
        planApproved: true,
      });

      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com", apiKey: "key" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );

      expect(sockets[0].url).toBe("wss://example.com/sessions/ses_new/ws?token=key&cursor=0");
      expect(useSessionStore.getState().messages).toEqual([]);
      expect(useSessionStore.getState().activityLog).toEqual([]);
      expect(useSessionStore.getState().sessionPhase).toBeNull();
      expect(useSessionStore.getState().planApproved).toBe(false);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("sends human chat messages over the websocket", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      url: string;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }

      send(message: string) {
        this.sent.push(message);
      }
      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com", apiKey: "key", participantId: "usr_123", displayName: "Alice" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );

      useSessionStore.getState().sendHumanMessage(" hello room ");

      expect(JSON.parse(sockets[0].sent[0])).toEqual({
        type: "human_message",
        text: "hello room",
      });
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("sends @codevil messages as agent requests", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      url: string;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }

      send(message: string) {
        this.sent.push(message);
      }
      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com", apiKey: "key", participantId: "usr_123", displayName: "Alice" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );

      useSessionStore.getState().sendRoomMessage("@codevil fix the failing test");

      expect(JSON.parse(sockets[0].sent[0])).toEqual({
        type: "agent_request",
        text: "fix the failing test",
      });
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
