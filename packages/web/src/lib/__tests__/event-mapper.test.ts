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

  it("carries the actor from an attributed status event", () => {
    const event: DOToCLIEvent = {
      type: "status",
      message: "Plan approved. Starting execution.",
      actor: "Alice",
    };
    const messages = mapEventToChat(event);
    expect(messages[0].actor).toBe("Alice");
  });

  it("leaves actor undefined for an unattributed status event", () => {
    const event: DOToCLIEvent = { type: "status", message: "Cloning repo." };
    const messages = mapEventToChat(event);
    expect(messages[0].actor).toBeUndefined();
  });

  it("maps room_ready to a room-ready status message", () => {
    const event: DOToCLIEvent = { type: "room_ready", repo: "github.com/acme/app" };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("status");
    expect(messages[0].content).toBe("Room ready for github.com/acme/app");
  });

  it("keeps participant join and leave noise out of conversation", () => {
    const joined = mapEventToChat({
      type: "participant_joined",
      participant: { id: "usr_123", name: "Alice" },
    });
    const left = mapEventToChat({
      type: "participant_left",
      participant: { id: "usr_123", name: "Alice" },
    });

    expect(joined).toEqual([]);
    expect(left).toEqual([]);
  });

  it("maps human messages to user chat messages with actor attribution", () => {
    const messages = mapEventToChat({
      type: "human_message",
      id: "msg_123",
      actor: { id: "usr_123", name: "Alice" },
      text: "hello room",
      created_at: "2026-06-03T00:00:00.000Z",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].variant).toBe("text");
    expect(messages[0].content).toBe("hello room");
    expect(messages[0].actor).toBe("Alice");
  });

  it("carries the actor from an attributed error event", () => {
    const event: DOToCLIEvent = {
      type: "error",
      message: "Alice already approved this plan.",
      actor: "Alice",
    };
    const messages = mapEventToChat(event);
    expect(messages[0].actor).toBe("Alice");
  });

  it("does not render awaiting approval status separately from the plan card", () => {
    const event: DOToCLIEvent = { type: "status", message: "Waiting for user approval." };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(0);
  });

  it("keeps phase events out of conversation", () => {
    const event: DOToCLIEvent = { type: "phase", phase: "planning", model: "claude-sonnet-4-6" };
    const messages = mapEventToChat(event);
    expect(messages).toEqual([]);
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

  it("maps approval_requested to a plan message scoped to the run", () => {
    const event: DOToCLIEvent = {
      type: "approval_requested",
      run_id: "run_123",
      plan: "## Plan\n\n1. Do X",
      cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.01 },
      refinement_round: 0,
    };
    const messages = mapEventToChat(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].variant).toBe("plan");
    expect(messages[0].content).toBe("## Plan\n\n1. Do X");
    expect(messages[0].meta?.run_id).toBe("run_123");
  });

  it("maps agent request queue events to room status messages", () => {
    const requested = mapEventToChat({
      type: "agent_request",
      run_id: "run_123",
      actor: { id: "usr_123", name: "Alice" },
      text: "fix the bug",
      created_at: "2026-06-03T00:00:00.000Z",
    });
    const queued = mapEventToChat({
      type: "agent_request_queued",
      run_id: "run_124",
      position: 2,
    });
    const started = mapEventToChat({
      type: "agent_run_started",
      run_id: "run_123",
      actor: { id: "usr_123", name: "Alice" },
      text: "fix the bug",
    });

    expect(requested[0].role).toBe("user");
    expect(requested[0].actor).toBe("Alice");
    expect(requested[0].content).toBe("@codevil fix the bug");
    expect(queued[0].content).toBe("Queued agent request #2.");
    expect(started).toEqual([]);
  });

  it("keeps run completion out of chat and maps failures", () => {
    const completed = mapEventToChat({
      type: "agent_run_completed",
      run_id: "run_123",
      pr_url: "https://github.com/user/repo/pull/1",
    });
    const failed = mapEventToChat({
      type: "agent_run_failed",
      run_id: "run_123",
      message: "tests failed",
    });

    expect(completed).toEqual([]);
    expect(failed[0].variant).toBe("error");
    expect(failed[0].content).toBe("tests failed");
  });

  it("maps the final agent response to one assistant message", () => {
    const messages = mapEventToChat({
      type: "agent_response",
      run_id: "run_123",
      text: "Rate limits are configured in src/rate-limit.ts.",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].variant).toBe("text");
    expect(messages[0].content).toBe("Rate limits are configured in src/rate-limit.ts.");
    expect(messages[0].meta?.run_id).toBe("run_123");
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

  it("keeps completed agent tools out of conversation", () => {
    const event: DOToCLIEvent = {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "bash", args: { command: "npm test" }, success: true },
    };
    const messages = mapEventToChat(event);
    expect(messages).toEqual([]);
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

  it("keeps markdown heading deltas out of durable conversation messages", () => {
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

    expect(projected.messages).toHaveLength(0);
    expect(projected.activityLog).toHaveLength(1);
    expect(projected.activityLog[0].kind).toBe("thinking");
  });

  it("keeps agent_end final assistant text in activity only", () => {
    const projected = projectEvent(
      { messages: [], activityLog: [] },
      {
        type: "agent_event",
        event: {
          type: "agent_end",
          messages: [
            { role: "assistant", content: "I updated the checkout page and verified the tests." },
          ],
        },
      },
    );

    expect(projected.messages).toHaveLength(0);
    expect(projected.activityLog.at(-1)?.event?.label).toBe("Agent finished");
  });

  it("does not promote agent_end text when a plan message exists", () => {
    const projected = projectEvent(
      {
        messages: [
          {
            id: "plan_1",
            role: "assistant",
            variant: "plan",
            content: "## Plan\n\n1. Update checkout.",
            timestamp: 1,
          },
        ],
        activityLog: [],
      },
      {
        type: "agent_event",
        event: {
          type: "agent_end",
          messages: [
            { role: "assistant", content: "## Plan\n\n1. Update checkout." },
          ],
        },
      },
    );

    expect(projected.messages).toHaveLength(1);
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

    expect(ended.messages).toHaveLength(0);
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
    expect(entries[0].phase?.label).toContain("Agent turn");
  });

  it("maps agent run start to activity instead of conversation", () => {
    const event: DOToCLIEvent = {
      type: "agent_run_started",
      run_id: "run_123",
      actor: { id: "usr_123", name: "Alice" },
      text: "fix the test",
    };

    expect(mapEventToChat(event)).toEqual([]);
    expect(mapEventToActivity(event)[0].event?.label).toBe("Agent run started");
    expect(mapEventToActivity(event)[0].event?.detail).toBe("fix the test");
  });

  it("returns empty array for events with no activity representation", () => {
    const event: DOToCLIEvent = { type: "session_created", session_id: "ses_abc" };
    const entries = mapEventToActivity(event);
    expect(entries).toHaveLength(0);
  });
});
