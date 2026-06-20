import { afterEach, describe, expect, it, vi } from "vitest";
import { inferPhase, inferPlanApproved, reduceParticipants, reducePreviewState, useSessionStore } from "../session-store";

// Minimal WebSocket stub shape used by replay_batch tests that share this definition.
interface IFakeWebSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(): void;
  close(): void;
}

// Factory that creates a FakeWebSocket constructor which pushes instances
// into the provided `sockets` array.  Used by the three onReplayBatch tests
// to avoid repeating the same 15-line class body verbatim.
function makeFakeWebSocket(sockets: IFakeWebSocket[]) {
  return class {
    static OPEN = 1;
    readyState = 1;
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      (sockets as unknown[]).push(this);
    }
    send() {}
    close() {}
  };
}

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
        { endpoint: "https://example.com" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );

      expect(sockets[0].url).toBe("wss://example.com/sessions/ses_new/ws?cursor=0");
      expect(useSessionStore.getState().messages).toEqual([]);
      expect(useSessionStore.getState().activityLog).toEqual([]);
      expect(useSessionStore.getState().participants).toEqual([]);
      expect(useSessionStore.getState().sessionPhase).toBeNull();
      expect(useSessionStore.getState().planApproved).toBe(false);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("stores the fetched session creator when connecting to a session", () => {
    const originalWebSocket = globalThis.WebSocket;

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
      }

      send() {}
      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
        { sessionCreatorId: "usr_creator" },
      );

      expect(useSessionStore.getState().sessionCreatorId).toBe("usr_creator");
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
        { endpoint: "https://example.com" },
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
        { endpoint: "https://example.com" },
        "ses_new",
        "https://example.com/sessions/ses_new/ws",
      );
      sockets[0].readyState = FakeWebSocket.OPEN;
      sockets[0].onopen?.();

      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
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
        { endpoint: "https://example.com" },
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
        { endpoint: "https://example.com" },
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

  it("onSnapshot replaces all projection-derived store fields with the frame's state", () => {
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
        { endpoint: "https://example.com" },
        "ses_snap",
        "https://example.com/sessions/ses_snap/ws",
      );

      // Set some stale state that should be overwritten by the snapshot
      useSessionStore.setState({
        messages: [{ id: "stale", role: "system", variant: "status", content: "old", timestamp: 0 }],
        participants: [{ id: "usr_stale", name: "Stale User" }],
        sessionPhase: "awaiting_approval",
        planApproved: true,
        cursor: 5,
      });

      const snapshotState = {
        cursor: 42,
        sessionPhase: "executing",
        planApproved: false,
        messages: [
          { id: "msg_1", role: "assistant", variant: "text", content: "hello from snapshot", timestamp: 100 },
        ],
        activityLog: [
          { id: "act_1", kind: "event", status: "success", timestamp: 100, event: { label: "Session created" } },
        ],
        participants: [{ id: "usr_alice", name: "Alice" }],
        preview: { status: "idle", url: null, command: null, port: null, error: null, apps: [], selectedAppKey: null, reloadRevision: 0, outputLines: [] },
        planRevision: null,
        annotations: [],
        questions: [],
        selectedAnnotationId: null,
      };

      // Simulate receiving a snapshot frame
      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          path: "session",
          cursor: 42,
          state: snapshotState,
        }),
      });

      const storeState = useSessionStore.getState();
      expect(storeState.cursor).toBe(42);
      expect(storeState.sessionPhase).toBe("executing");
      expect(storeState.planApproved).toBe(false);
      expect(storeState.messages).toHaveLength(1);
      expect(storeState.messages[0].id).toBe("msg_1");
      expect(storeState.activityLog).toHaveLength(1);
      expect(storeState.participants).toHaveLength(1);
      expect(storeState.participants[0].id).toBe("usr_alice");
      expect(storeState.annotations).toEqual([]);
      expect(storeState.questions).toEqual([]);
      expect(storeState.selectedAnnotationId).toBeNull();
      expect(storeState.preview).toEqual(snapshotState.preview);
      expect(storeState.planRevision).toEqual(snapshotState.planRevision);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("onSnapshot does not affect state from a stale connection generation", () => {
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
        { endpoint: "https://example.com" },
        "ses_gen",
        "https://example.com/sessions/ses_gen/ws",
      );

      // Immediately connect again, invalidating the first generation
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_gen_2",
        "https://example.com/sessions/ses_gen_2/ws",
      );

      // A snapshot frame arriving on the first (stale) socket should be ignored
      const staleSnapshotState = {
        cursor: 99,
        sessionPhase: "completed",
        planApproved: true,
        messages: [{ id: "stale_msg", role: "system", variant: "status", content: "stale", timestamp: 0 }],
        activityLog: [],
        participants: [],
        preview: { status: "idle", url: null, command: null, port: null, error: null, apps: [], selectedAppKey: null, reloadRevision: 0, outputLines: [] },
        planRevision: null,
        annotations: [],
        questions: [],
        selectedAnnotationId: null,
      };

      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          path: "session",
          cursor: 99,
          state: staleSnapshotState,
        }),
      });

      // State should not reflect the stale snapshot
      const storeState = useSessionStore.getState();
      expect(storeState.cursor).not.toBe(99);
      expect(storeState.sessionPhase).not.toBe("completed");
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("onReplayBatch applies all events in order in a single update", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: IFakeWebSocket[] = [];
    globalThis.WebSocket = makeFakeWebSocket(sockets) as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_batch",
        "https://example.com/sessions/ses_batch/ws",
      );

      // Send a replay_batch with a session_created and a participant_joined
      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: "replay_batch",
          events: [
            { cursor: 1, event: { type: "session_created", session_id: "ses_batch" } },
            {
              cursor: 2,
              event: {
                type: "participant_joined",
                participant: { id: "usr_alice", name: "Alice" },
              },
            },
          ],
        }),
      });

      const storeState = useSessionStore.getState();
      // Cursor should advance to the last event's cursor
      expect(storeState.cursor).toBe(2);
      // Participant should be reflected in the store
      expect(storeState.participants.some((p: { id: string }) => p.id === "usr_alice")).toBe(true);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("replay_batch is applied synchronously without draining timers (bypasses pendingEvents debounce)", () => {
    vi.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const sockets: IFakeWebSocket[] = [];
    globalThis.WebSocket = makeFakeWebSocket(sockets) as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_sync",
        "https://example.com/sessions/ses_sync/ws",
      );

      // Dispatch a replay_batch with two events.
      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: "replay_batch",
          events: [
            { cursor: 1, event: { type: "session_created", session_id: "ses_sync" } },
            {
              cursor: 2,
              event: {
                type: "participant_joined",
                participant: { id: "usr_sync", name: "SyncUser" },
              },
            },
          ],
        }),
      });

      // State must reflect the batch IMMEDIATELY — no timer advancement allowed.
      // If this fails, onReplayBatch mistakenly queued events onto pendingEvents.
      const storeState = useSessionStore.getState();
      expect(storeState.cursor).toBe(2);
      expect(storeState.participants.some((p: { id: string }) => p.id === "usr_sync")).toBe(true);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("onReplayBatch with empty events does not change cursor", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: IFakeWebSocket[] = [];
    globalThis.WebSocket = makeFakeWebSocket(sockets) as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_empty_batch",
        "https://example.com/sessions/ses_empty_batch/ws",
      );

      // connectToSession starts a fresh session at cursor 0.
      // An empty replay_batch ("you're up to date") must not advance the cursor.
      sockets[0].onmessage?.({
        data: JSON.stringify({ type: "replay_batch", events: [] }),
      });

      expect(useSessionStore.getState().cursor).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("onReplayBatch from a stale connection is ignored", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: IFakeWebSocket[] = [];
    globalThis.WebSocket = makeFakeWebSocket(sockets) as unknown as typeof WebSocket;

    try {
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_stale_1",
        "https://example.com/sessions/ses_stale_1/ws",
      );
      // Immediately connect again, invalidating the first generation
      useSessionStore.getState().connectToSession(
        { endpoint: "https://example.com" },
        "ses_stale_2",
        "https://example.com/sessions/ses_stale_2/ws",
      );

      // A replay_batch on the first (stale) socket should be ignored
      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: "replay_batch",
          events: [
            {
              cursor: 99,
              event: {
                type: "participant_joined",
                participant: { id: "usr_stale", name: "Stale" },
              },
            },
          ],
        }),
      });

      const storeState = useSessionStore.getState();
      expect(storeState.cursor).not.toBe(99);
      expect(storeState.participants.some((p: { id: string }) => p.id === "usr_stale")).toBe(false);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
