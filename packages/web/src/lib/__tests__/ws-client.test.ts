import { afterEach, describe, it, expect, vi } from "vitest";
import { buildWebSocketUrl, connectWebSocket, parseEnvelope } from "../ws-client";
import type { SnapshotFrame } from "@codevil/shared";

afterEach(() => {
  vi.useRealTimers();
});

describe("buildWebSocketUrl", () => {
  it("adds the replay cursor param", () => {
    const url = buildWebSocketUrl("wss://example.com/sessions/ses_1/ws", 0);
    expect(url).toBe("wss://example.com/sessions/ses_1/ws?cursor=0");
  });

  it("converts https to wss", () => {
    const url = buildWebSocketUrl("https://example.com/sessions/ses_1/ws", 5);
    expect(url).toBe("wss://example.com/sessions/ses_1/ws?cursor=5");
  });

  it("converts http to ws", () => {
    const url = buildWebSocketUrl("http://localhost:8787/sessions/ses_1/ws", 0);
    expect(url).toBe("ws://localhost:8787/sessions/ses_1/ws?cursor=0");
  });

  it("does not include self-declared browser identity params", () => {
    const url = buildWebSocketUrl("wss://example.com/sessions/ses_1/ws?name=Eve&participant_id=usr_eve&token=bad", 0);

    expect(url).toBe("wss://example.com/sessions/ses_1/ws?cursor=0");
  });
});

describe("parseEnvelope", () => {
  it("parses a valid envelope", () => {
    const raw = JSON.stringify({ cursor: 5, event: { type: "status", message: "hello" } });
    const env = parseEnvelope(raw);
    expect(env.cursor).toBe(5);
    expect(env.event.type).toBe("status");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseEnvelope("not json")).toThrow();
  });
});

describe("connectWebSocket", () => {
  // Shared FakeWebSocket class used across tests in this describe block.
  // Individual tests that need custom behaviour (e.g. readyState = 0 on
  // construction, or a `sent` array) override only what they need via the
  // per-test `sockets` array captured in the constructor.
  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(public url: string) {}
    send(message: string) { this.sent.push(message); }
    close() {}
  }

  it("queues messages while connecting and flushes them when open", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class LocalFakeWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = 0;
        sockets.push(this);
      }
    }

    globalThis.WebSocket = LocalFakeWebSocket as unknown as typeof WebSocket;
    try {
      const client = connectWebSocket({
        wsUrl: "wss://example.com/sessions/ses_1/ws",
        onEvent() {},
      });
      client.send({ type: "human_message", text: "hello" });
      expect(sockets[0].sent).toEqual([]);

      sockets[0].readyState = FakeWebSocket.OPEN;
      sockets[0].onopen?.();
      expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "human_message", text: "hello" });
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("reconnects after an unexpected close using the latest cursor", () => {
    vi.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];
    const reconnecting = vi.fn();

    class LocalFakeWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = 0;
        sockets.push(this);
      }
    }

    globalThis.WebSocket = LocalFakeWebSocket as unknown as typeof WebSocket;
    try {
      connectWebSocket({
        wsUrl: "wss://example.com/sessions/ses_1/ws",
        onEvent() {},
        onReconnecting: reconnecting,
      });
      sockets[0].onmessage?.({ data: JSON.stringify({ cursor: 9, event: { type: "status", message: "ready" } }) });
      sockets[0].onclose?.({ code: 1006, reason: "" });

      expect(reconnecting).toHaveBeenCalled();
      vi.runOnlyPendingTimers();
      expect(sockets[1].url).toContain("cursor=9");
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("calls onSnapshot when a snapshot frame is received and skips onEvent", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class LocalFakeWebSocket extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    }

    globalThis.WebSocket = LocalFakeWebSocket as unknown as typeof WebSocket;
    try {
      const onEvent = vi.fn();
      const onSnapshot = vi.fn();

      connectWebSocket({
        wsUrl: "wss://example.com/sessions/ses_1/ws",
        onEvent,
        onSnapshot,
      });

      const snapshotFrame = {
        type: "snapshot",
        path: "session",
        cursor: 42,
        state: { sessionPhase: "executing", messages: [], participants: [] },
      };
      sockets[0].onmessage?.({ data: JSON.stringify(snapshotFrame) });

      expect(onSnapshot).toHaveBeenCalledTimes(1);
      const received = onSnapshot.mock.calls[0][0] as SnapshotFrame;
      expect(received.type).toBe("snapshot");
      expect(received.cursor).toBe(42);
      expect(received.path).toBe("session");
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("advances the cursor after receiving a snapshot frame so reconnects resume after it", () => {
    vi.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class LocalFakeWebSocket extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    }

    globalThis.WebSocket = LocalFakeWebSocket as unknown as typeof WebSocket;
    try {
      connectWebSocket({
        wsUrl: "wss://example.com/sessions/ses_1/ws",
        onEvent() {},
        onSnapshot() {},
      });

      // Receive a snapshot at cursor 99
      sockets[0].onmessage?.({ data: JSON.stringify({ type: "snapshot", path: "session", cursor: 99, state: {} }) });
      // Trigger a reconnect
      sockets[0].onclose?.({ code: 1006, reason: "" });
      vi.runOnlyPendingTimers();

      // The reconnect URL should resume from cursor 99 (or higher)
      expect(sockets[1].url).toContain("cursor=99");
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("ignores a malformed snapshot frame (missing cursor) without crashing", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class LocalFakeWebSocket extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    }

    globalThis.WebSocket = LocalFakeWebSocket as unknown as typeof WebSocket;
    try {
      const onSnapshot = vi.fn();
      connectWebSocket({
        wsUrl: "wss://example.com/sessions/ses_1/ws",
        onEvent() {},
        onSnapshot,
      });

      // Missing `cursor` field — safeParse should fail, onSnapshot should not be called
      sockets[0].onmessage?.({ data: JSON.stringify({ type: "snapshot", path: "session", state: {} }) });
      expect(onSnapshot).not.toHaveBeenCalled();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
