import { afterEach, describe, it, expect, vi } from "vitest";
import { buildWebSocketUrl, connectWebSocket, parseEnvelope } from "../ws-client";

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
  it("queues messages while connecting and flushes them when open", () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(public url: string) { sockets.push(this); }
      send(message: string) { this.sent.push(message); }
      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
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

    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(public url: string) { sockets.push(this); }
      send() {}
      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
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
});
