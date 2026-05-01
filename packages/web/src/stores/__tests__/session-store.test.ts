import { afterEach, describe, expect, it } from "vitest";
import { inferPhase, inferPlanApproved, useSessionStore } from "../session-store";

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
});
