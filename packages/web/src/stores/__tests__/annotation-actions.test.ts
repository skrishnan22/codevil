/**
 * Tests for the annotation store actions: replyToAnnotation, withdrawAnnotation,
 * and setCurrentUserId. Follows the pattern established in session-store.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { useSessionStore } from "../session-store";

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
  }

  send(message: string) {
    this.sent.push(message);
  }
  close() {}
}

function withConnectedStore(cb: (socket: FakeWebSocket) => void) {
  const sockets: FakeWebSocket[] = [];
  const OriginalWebSocket = globalThis.WebSocket;

  class TrackingWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }

  globalThis.WebSocket = TrackingWebSocket as unknown as typeof WebSocket;

  try {
    useSessionStore.getState().connectToSession(
      { endpoint: "https://example.com" },
      "ses_1",
      "https://example.com/sessions/ses_1/ws",
    );
    cb(sockets[0]);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
}

describe("replyToAnnotation", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
  });

  it("sends the correct annotation_reply message shape", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().replyToAnnotation("thread_abc", "Looks good!");
      expect(JSON.parse(socket.sent[0])).toEqual({
        type: "annotation_reply",
        thread_id: "thread_abc",
        comment: "Looks good!",
      });
    });
  });

  it("trims comment whitespace before sending", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().replyToAnnotation("thread_abc", "  hello  ");
      expect(JSON.parse(socket.sent[0])).toEqual({
        type: "annotation_reply",
        thread_id: "thread_abc",
        comment: "hello",
      });
    });
  });

  it("is a no-op when comment is empty", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().replyToAnnotation("thread_abc", "   ");
      expect(socket.sent).toHaveLength(0);
    });
  });

  it("is a no-op when not connected (wsHandle is null)", () => {
    // Don't connect — just call directly.
    expect(() => {
      useSessionStore.getState().replyToAnnotation("thread_abc", "hello");
    }).not.toThrow();
  });
});

describe("withdrawAnnotation", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
  });

  it("sends the correct annotation_withdraw message shape", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().withdrawAnnotation("thread_xyz");
      expect(JSON.parse(socket.sent[0])).toEqual({
        type: "annotation_withdraw",
        thread_id: "thread_xyz",
      });
    });
  });

  it("is a no-op when not connected (wsHandle is null)", () => {
    expect(() => {
      useSessionStore.getState().withdrawAnnotation("thread_xyz");
    }).not.toThrow();
  });
});

describe("setCurrentUserId", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
  });

  it("updates currentUserId in store state", () => {
    expect(useSessionStore.getState().currentUserId).toBeNull();
    useSessionStore.getState().setCurrentUserId("usr_123");
    expect(useSessionStore.getState().currentUserId).toBe("usr_123");
  });

  it("can be cleared back to null", () => {
    useSessionStore.getState().setCurrentUserId("usr_123");
    useSessionStore.getState().setCurrentUserId(null);
    expect(useSessionStore.getState().currentUserId).toBeNull();
  });

  it("is reset to null by reset()", () => {
    useSessionStore.getState().setCurrentUserId("usr_123");
    useSessionStore.getState().reset();
    expect(useSessionStore.getState().currentUserId).toBeNull();
  });
});

describe("refine", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
  });

  it("sends refine_plan with the provided feedback", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().refine("please simplify step 2");
      expect(JSON.parse(socket.sent[0])).toEqual({
        type: "refine_plan",
        feedback: "please simplify step 2",
      });
    });
  });

  it("sends refine_plan with empty feedback when called with empty string", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().refine("");
      expect(JSON.parse(socket.sent[0])).toEqual({
        type: "refine_plan",
        feedback: "",
      });
    });
  });

  it("is a no-op when not connected (wsHandle is null)", () => {
    expect(() => {
      useSessionStore.getState().refine("anything");
    }).not.toThrow();
  });
});

describe("approve", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
  });

  it("sends the correct approve message", () => {
    withConnectedStore((socket) => {
      useSessionStore.getState().approve();
      expect(JSON.parse(socket.sent[0])).toEqual({ type: "approve" });
    });
  });

  it("is a no-op when not connected (wsHandle is null)", () => {
    expect(() => {
      useSessionStore.getState().approve();
    }).not.toThrow();
  });
});
