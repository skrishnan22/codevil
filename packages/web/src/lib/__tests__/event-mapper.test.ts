import { describe, it, expect } from "vitest";
import { mapEventToChat, mapEventToActivity, projectEvent } from "../event-mapper";
import type { DOToCLIEvent } from "@codevil/shared";

describe("mapEventToChat", () => {
  it("maps session_created to a system message", () => {
    const event: DOToCLIEvent = { type: "session_created", session_id: "ses_abc" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].variant).toBe("status");
    expect(messages[0].content).toContain("ses_abc");
  });

  it("maps status to a system message", () => {
    const event: DOToCLIEvent = { type: "status", message: "Provisioning sandbox..." };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].variant).toBe("status");
    expect(messages[0].content).toBe("Provisioning sandbox...");
  });

  it("does not render awaiting approval status separately from the plan card", () => {
    const event: DOToCLIEvent = { type: "status", message: "Waiting for user approval." };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(0);
  });

  it("maps phase to a phase badge message", () => {
    const event: DOToCLIEvent = { type: "phase", phase: "planning", model: "claude-sonnet-4-6" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("phase");
    expect(messages[0].meta?.phase).toBe("planning");
    expect(messages[0].meta?.model).toBe("claude-sonnet-4-6");
  });

  it("maps plan_ready to a plan message", () => {
    const event: DOToCLIEvent = {
      type: "plan_ready",
      plan: "## Plan\n\n1. Do X",
      cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.01 },
      refinement_round: 0,
    };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("plan");
    expect(messages[0].content).toBe("## Plan\n\n1. Do X");
    expect(messages[0].meta?.cost?.total_cost_usd).toBe(0.01);
    expect(messages[0].meta?.refinement_round).toBe(0);
  });

  it("maps complete to a complete message with pr_url", () => {
    const event: DOToCLIEvent = { type: "complete", pr_url: "https://github.com/user/repo/pull/1" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("complete");
    expect(messages[0].meta?.pr_url).toBe("https://github.com/user/repo/pull/1");
  });

  it("maps error to an error message", () => {
    const event: DOToCLIEvent = { type: "error", message: "Something broke" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("error");
    expect(messages[0].content).toBe("Something broke");
  });

  it("maps meaningful completed agent tools to durable tool summaries", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "bash", args: { command: "npm test" }, success: true },
    };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("tool_summary");
    expect(messages[0].meta?.tool_name).toBe("bash");
  });

  it("does not put low-signal read-only tools in the durable timeline", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "tool_execution_end", toolName: "find", args: { path: ".", pattern: "README.md" }, isError: false },
    };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(0);
  });

  it("keeps agent message_update events out of the durable timeline", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "message_update", content: "Let me look at" },
    };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(0);
  });

  it("keeps clone_progress line noise out of the durable timeline", () => {
    const event: DOToCLIEvent = { type: "clone_progress", line: "Receiving objects: 50%" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(0);
  });

  it("maps verification_failed to a verification_failed message", () => {
    const event: DOToCLIEvent = { type: "verification_failed", attempts: 3, last_error: "test failed" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("verification_failed");
    expect(messages[0].meta?.attempts).toBe(3);
    expect(messages[0].meta?.last_error).toBe("test failed");
  });
});

describe("projectEvent", () => {
  it("coalesces streamed message updates into one thinking entry", () => {
    const first = projectEvent(
      { messages: [], activityLog: [] },
      { type: "agent_event", event: { type: "message_update", content: "Analyzing " } },
    );
    const second = projectEvent(
      first,
      { type: "agent_event", event: { type: "message_update", content: "the repo." } },
    );

    expect(second.messages).toHaveLength(0);
    expect(second.activityLog).toHaveLength(1);
    expect(second.activityLog[0].kind).toBe("thinking");
    expect(second.activityLog[0].thinking?.text).toBe("Analyzing the repo.");
  });

  it("coalesces Pi assistant text deltas into one thinking entry", () => {
    const first = projectEvent(
      { messages: [], activityLog: [] },
      {
        type: "agent_event",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Reading " },
        },
      },
    );
    const second = projectEvent(
      first,
      {
        type: "agent_event",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "files." },
        },
      },
    );

    expect(second.activityLog).toHaveLength(1);
    expect(second.activityLog[0].thinking?.text).toBe("Reading files.");
  });

  it("promotes agent markdown headings into durable progress timeline events", () => {
    const projected = projectEvent(
      { messages: [], activityLog: [] },
      {
        type: "agent_event",
        event: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "**Inspecting package.json**\n\nI need to check the scripts.",
          },
        },
      },
    );

    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0].variant).toBe("progress");
    expect(projected.messages[0].content).toBe("Inspecting package.json");
  });

  it("does not duplicate the same promoted progress heading", () => {
    const first = projectEvent(
      { messages: [], activityLog: [] },
      {
        type: "agent_event",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "**Inspecting package.json**" },
        },
      },
    );
    const second = projectEvent(
      first,
      {
        type: "agent_event",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "\n\n**Inspecting package.json**" },
        },
      },
    );

    expect(second.messages).toHaveLength(1);
  });

  it("updates a running tool entry when the matching tool ends", () => {
    const started = projectEvent(
      { messages: [], activityLog: [] },
      { type: "agent_event", event: { type: "tool_execution_start", tool: "bash", args: { command: "pnpm test" } } },
    );
    const ended = projectEvent(
      started,
      { type: "agent_event", event: { type: "tool_execution_end", tool: "bash", args: { command: "pnpm test" }, result: "PASS", success: true } },
    );

    expect(ended.messages).toHaveLength(1);
    expect(ended.messages[0].variant).toBe("tool_summary");
    expect(ended.activityLog).toHaveLength(1);
    expect(ended.activityLog[0].status).toBe("success");
    expect(ended.activityLog[0].tool?.result).toBe("PASS");
  });

  it("updates Pi tool events using toolCallId", () => {
    const started = projectEvent(
      { messages: [], activityLog: [] },
      {
        type: "agent_event",
        event: {
          type: "tool_execution_start",
          toolCallId: "call_1",
          toolName: "read",
          args: { path: "src/index.ts" },
        },
      },
    );
    const ended = projectEvent(
      started,
      {
        type: "agent_event",
        event: {
          type: "tool_execution_end",
          toolCallId: "call_1",
          toolName: "read",
          result: "file contents",
          isError: false,
        },
      },
    );

    expect(ended.activityLog).toHaveLength(1);
    expect(ended.activityLog[0].status).toBe("success");
    expect(ended.activityLog[0].tool?.name).toBe("read");
    expect(ended.activityLog[0].tool?.result).toBe("file contents");
  });

  it("renders generic Pi lifecycle events in the activity pane", () => {
    const projected = projectEvent(
      { messages: [], activityLog: [] },
      { type: "agent_event", event: { type: "agent_start" } },
    );

    expect(projected.activityLog).toHaveLength(1);
    expect(projected.activityLog[0].kind).toBe("event");
    expect(projected.activityLog[0].event?.label).toBe("Agent started");
  });
});

describe("mapEventToActivity", () => {
  it("maps agent_event tool_execution_start to a running tool_call entry", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "tool_execution_start", tool: "bash", args: { command: "npm test" } },
    };
    const entries = mapEventToActivity(event);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_call");
    expect(entries[0].status).toBe("running");
    expect(entries[0].tool?.name).toBe("bash");
    expect(entries[0].tool?.summary).toBe("Run npm test");
  });

  it("maps agent_event tool_execution_end to a completed tool_call entry", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "bash", args: { command: "npm test" }, result: "PASS", success: true },
    };
    const entries = mapEventToActivity(event);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_call");
    expect(entries[0].status).toBe("success");
    expect(entries[0].tool?.name).toBe("bash");
    expect(entries[0].tool?.result).toBe("PASS");
  });

  it("maps agent_event message_update to a thinking entry", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "message_update", content: "Analyzing the code..." },
    };
    const entries = mapEventToActivity(event);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thinking");
    expect(entries[0].thinking?.text).toBe("Analyzing the code...");
  });

  it("maps phase event to a phase_divider entry", () => {
    const event: DOToCLIEvent = { type: "phase", phase: "executing", model: "claude-opus-4-6" };
    const entries = mapEventToActivity(event);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("phase_divider");
    expect(entries[0].phase?.label).toContain("Executing");
  });

  it("returns empty array for events with no activity representation", () => {
    const event: DOToCLIEvent = { type: "session_created", session_id: "ses_abc" };
    const entries = mapEventToActivity(event);
    expect(entries).toHaveLength(0);
  });
});
