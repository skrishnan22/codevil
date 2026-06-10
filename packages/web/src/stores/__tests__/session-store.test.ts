import { afterEach, describe, expect, it, vi } from "vitest";
import { inferPhase, inferPlanApproved, reduceParticipants, reducePreviewState, useSessionStore } from "../session-store";

describe("session event state inference", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
    vi.useRealTimers();
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
    const idle = {
      status: "idle" as const,
      url: null,
      command: null,
      port: null,
      error: null,
      apps: [],
      selectedAppKey: null,
      reloadRevision: 0,
      outputLines: [],
    };
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
    const idle = {
      status: "idle" as const,
      url: null,
      command: null,
      port: null,
      error: null,
      apps: [],
      selectedAppKey: null,
      reloadRevision: 0,
      outputLines: [],
    };
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
      reloadRevision: 0,
      outputLines: [],
    };
    const refreshed = reducePreviewState(selected, { type: "preview_apps", apps });
    expect(refreshed.selectedAppKey).toBe("apps/landing");
  });

  it("captures preview command output while preview is starting", () => {
    const starting = reducePreviewState({
      status: "idle" as const,
      url: null,
      command: null,
      port: null,
      error: null,
      apps: [],
      selectedAppKey: null,
      reloadRevision: 0,
      outputLines: ["stale output"],
    }, { type: "preview_starting", command: "pnpm dev -- --host 0.0.0.0", port: 5173 });

    const first = reducePreviewState(starting, {
      type: "status",
      message: "Preview output: VITE v6.0.0 ready",
    });
    const second = reducePreviewState(first, {
      type: "status",
      message: "Preview output: Local: http://localhost:5173/",
    });
    const ignored = reducePreviewState(second, {
      type: "status",
      message: "Repository cloned. Room is ready.",
    });

    expect(starting.outputLines).toEqual([]);
    expect(ignored.outputLines).toEqual([
      "VITE v6.0.0 ready",
      "Local: http://localhost:5173/",
    ]);
  });

  it("tracks participants from join and leave events", () => {
    const alice = { id: "usr_1", name: "Alice" };
    const bob = { id: "usr_2", name: "Bob" };

    const joinedAlice = reduceParticipants([], {
      type: "participant_joined",
      participant: alice,
    });
    const joinedBob = reduceParticipants(joinedAlice, {
      type: "participant_joined",
      participant: bob,
    });
    const renamedAlice = reduceParticipants(joinedBob, {
      type: "participant_joined",
      participant: { id: "usr_1", name: "Alice Smith" },
    });
    const leftBob = reduceParticipants(renamedAlice, {
      type: "participant_left",
      participant: bob,
    });

    expect(joinedBob).toEqual([alice, bob]);
    expect(renamedAlice).toEqual([{ id: "usr_1", name: "Alice Smith" }, bob]);
    expect(leftBob).toEqual([{ id: "usr_1", name: "Alice Smith" }]);
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
        participants: [{ id: "usr_old", name: "Old User" }],
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
      expect(useSessionStore.getState().participants).toEqual([]);
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

  it("ignores stale close events from a replaced websocket", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
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
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com", apiKey: "key" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );
      sockets[0].readyState = FakeWebSocket.OPEN;
      sockets[0].onopen?.();

      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com", apiKey: "key" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );
      sockets[1].readyState = FakeWebSocket.OPEN;
      sockets[1].onopen?.();

      sockets[0].onclose?.({ code: 1000, reason: "client closed" });

      expect(useSessionStore.getState().connectionStatus).toBe("connected");
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

  it("debounces preview iframe reloads after completed agent writes", () => {
    vi.useFakeTimers();
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
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com", apiKey: "key" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );

      sockets[0].onmessage?.({
        data: JSON.stringify({
          cursor: 1,
          event: {
            type: "preview_ready",
            url: "https://preview.example/",
            command: "pnpm dev",
            port: 5173,
          },
        }),
      });

      expect(useSessionStore.getState().preview.reloadRevision).toBe(0);

      sockets[0].onmessage?.({
        data: JSON.stringify({
          cursor: 2,
          event: {
            type: "agent_event",
            event: {
              type: "tool_execution_end",
              toolName: "write",
              args: { path: "src/App.tsx" },
              success: true,
            },
          },
        }),
      });
      sockets[0].onmessage?.({
        data: JSON.stringify({
          cursor: 3,
          event: {
            type: "agent_event",
            event: {
              type: "tool_execution_end",
              toolName: "edit",
              args: { path: "src/styles.css" },
              success: true,
            },
          },
        }),
      });

      vi.advanceTimersByTime(999);
      expect(useSessionStore.getState().preview.reloadRevision).toBe(0);

      vi.advanceTimersByTime(1);
      expect(useSessionStore.getState().preview.reloadRevision).toBe(1);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
