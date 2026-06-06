import { describe, expect, it } from "vitest";
import { deriveCurrentAgent } from "../current-agent";
import type { ActivityEntry, ChatMessage } from "../../types";

describe("deriveCurrentAgent", () => {
  it("does not force plan approval attention over routine activity", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "assistant", variant: "plan", content: "## Plan", timestamp: 1 },
    ];
    const activityLog: ActivityEntry[] = [
      {
        id: "a1",
        kind: "thinking",
        status: "running",
        timestamp: 2,
        thinking: { text: "Reading files" },
      },
    ];

    const result = deriveCurrentAgent({
      messages,
      activityLog,
      sessionPhase: "awaiting_approval",
      planApproved: false,
    });

    expect(result.kind).toBe("running");
    expect(result.title).toBe("Agent is thinking");
  });

  it("shows running tool above thinking text", () => {
    const activityLog: ActivityEntry[] = [
      {
        id: "a1",
        kind: "thinking",
        status: "running",
        timestamp: 1,
        thinking: { text: "Inspecting files" },
      },
      {
        id: "a2",
        kind: "tool_call",
        status: "running",
        timestamp: 2,
        tool: { name: "bash", summary: "Run pnpm test" },
      },
    ];

    const result = deriveCurrentAgent({
      messages: [],
      activityLog,
      sessionPhase: "executing",
      planApproved: true,
    });

    expect(result.kind).toBe("running");
    expect(result.title).toBe("Run pnpm test");
    expect(result.badge).toBe("bash");
  });

  it("persists the last meaningful assistant reply when idle", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "assistant", variant: "text", content: "I updated the route.", timestamp: 1 },
    ];

    const result = deriveCurrentAgent({
      messages,
      activityLog: [],
      sessionPhase: "executing",
      planApproved: true,
    });

    expect(result.kind).toBe("summary");
    expect(result.title).toBe("Latest assistant reply");
    expect(result.description).toBe("I updated the route.");
  });

  it("shows verification failure attention", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "system",
        variant: "verification_failed",
        content: "Verification failed after 2 attempts.",
        timestamp: 1,
        meta: { attempts: 2, last_error: "Tests failed" },
      },
    ];

    const result = deriveCurrentAgent({
      messages,
      activityLog: [],
      sessionPhase: "failed",
      planApproved: true,
    });

    expect(result.kind).toBe("attention");
    expect(result.title).toBe("Verification failed");
    expect(result.description).toContain("Tests failed");
  });
});
