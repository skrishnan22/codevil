import { describe, it, expect } from "vitest";
import { buildWebSocketUrl, parseEnvelope } from "../ws-client";

describe("buildWebSocketUrl", () => {
  it("adds token and cursor params", () => {
    const url = buildWebSocketUrl("wss://example.com/sessions/ses_1/ws", "key123", 0);
    expect(url).toBe("wss://example.com/sessions/ses_1/ws?token=key123&cursor=0");
  });

  it("converts https to wss", () => {
    const url = buildWebSocketUrl("https://example.com/sessions/ses_1/ws", "key", 5);
    expect(url).toBe("wss://example.com/sessions/ses_1/ws?token=key&cursor=5");
  });

  it("converts http to ws", () => {
    const url = buildWebSocketUrl("http://localhost:8787/sessions/ses_1/ws", "key", 0);
    expect(url).toBe("ws://localhost:8787/sessions/ses_1/ws?token=key&cursor=0");
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
