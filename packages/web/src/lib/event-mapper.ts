import type { DOToCLIEvent } from "@codevil/shared";
import type { ChatMessage, ActivityEntry } from "../types";

export interface ProjectedSessionView {
  messages: ChatMessage[];
  activityLog: ActivityEntry[];
}

let nextId = 0;
function uid(): string {
  return `msg_${++nextId}`;
}

export function mapEventToChat(event: DOToCLIEvent): ChatMessage[] {
  const ts = Date.now();

  switch (event.type) {
    case "session_created":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `Session created: ${event.session_id}`,
          timestamp: ts,
        },
      ];

    case "status":
      if (event.message === "Waiting for user approval.") return [];
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: event.message,
          timestamp: ts,
        },
      ];

    case "clone_progress":
      return [];

    case "phase":
      return [
        {
          id: uid(),
          role: "system",
          variant: "phase",
          content: `${capitalize(event.phase)} with ${event.model}`,
          timestamp: ts,
          meta: { phase: event.phase, model: event.model },
        },
      ];

    case "plan_ready":
      return [
        {
          id: uid(),
          role: "assistant",
          variant: "plan",
          content: event.plan,
          timestamp: ts,
          meta: { cost: event.cost, refinement_round: event.refinement_round },
        },
      ];

    case "verification_failed":
      return [
        {
          id: uid(),
          role: "system",
          variant: "verification_failed",
          content: `Verification failed after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}.`,
          timestamp: ts,
          meta: { attempts: event.attempts, last_error: event.last_error },
        },
      ];

    case "complete":
      return [
        {
          id: uid(),
          role: "system",
          variant: "complete",
          content: "Session completed.",
          timestamp: ts,
          meta: { pr_url: event.pr_url },
        },
      ];

    case "error":
      return [
        {
          id: uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
        },
      ];

    case "agent_event":
      return mapAgentEventToChat(event.event, ts);
  }
}

function mapAgentEventToChat(raw: unknown, ts: number): ChatMessage[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_end": {
      const toolName = readToolName(raw);
      if (isLowSignalTool(toolName) && raw.isError !== true && raw.success !== false) return [];
      const summary = summarizeTool(toolName, raw.args);
      return [
        {
          id: uid(),
          role: "system",
          variant: "tool_summary",
          content: summary,
          timestamp: ts,
          meta: { tool_name: toolName },
        },
      ];
    }
    case "message_update":
      return [];
    default:
      return [];
  }
}

export function mapEventToActivity(event: DOToCLIEvent): ActivityEntry[] {
  const ts = Date.now();

  switch (event.type) {
    case "phase":
      return [
        {
          id: uid(),
          kind: "phase_divider",
          status: "success",
          timestamp: ts,
          phase: {
            label: `${capitalize(event.phase)} with ${event.model}`,
          },
        },
      ];

    case "agent_event":
      return mapAgentEventToActivity(event.event, ts);

    default:
      return [];
  }
}

function mapAgentEventToActivity(raw: unknown, ts: number): ActivityEntry[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_start": {
      const name = readToolName(raw);
      return [
        {
          id: uid(),
          kind: "tool_call",
          status: "running",
          timestamp: ts,
          tool: {
            callId: readToolCallId(raw),
            name,
            summary: summarizeTool(name, raw.args),
            args: raw.args ? JSON.stringify(raw.args) : undefined,
          },
        },
      ];
    }
    case "tool_execution_end": {
      const name = readToolName(raw);
      const success = raw.success !== false && raw.isError !== true;
      const result =
        typeof raw.result === "string"
          ? raw.result
          : JSON.stringify(raw.result ?? "");
      return [
        {
          id: uid(),
          kind: "tool_call",
          status: success ? "success" : "error",
          timestamp: ts,
          tool: {
            callId: readToolCallId(raw),
            name,
            summary: summarizeTool(name, raw.args),
            result,
            error:
              !success && typeof raw.error === "string"
                ? raw.error
                : undefined,
          },
        },
      ];
    }
    case "message_update": {
      const text = readMessageDelta(raw);
      return [
        {
          id: uid(),
          kind: "thinking",
          status: "running",
          timestamp: ts,
          thinking: { text },
        },
      ];
    }
    case "agent_start":
      return [eventEntry("Agent started", ts)];
    case "agent_end":
      return [eventEntry("Agent finished", ts)];
    case "turn_start":
      return [eventEntry("Turn started", ts)];
    case "turn_end":
      return [eventEntry("Turn finished", ts, describeTurnEnd(raw))];
    default:
      return [];
  }
}

export function projectEvent(
  state: ProjectedSessionView,
  event: DOToCLIEvent,
): ProjectedSessionView {
  const activityLog = projectActivity(state.activityLog, event);
  return {
    messages: projectMessages(state.messages, event),
    activityLog,
  };
}

export function projectEvents(
  state: ProjectedSessionView,
  events: DOToCLIEvent[],
): ProjectedSessionView {
  return events.reduce(projectEvent, state);
}

function projectMessages(messages: ChatMessage[], event: DOToCLIEvent): ChatMessage[] {
  const progress = extractProgressMessage(event, messages);
  if (progress) return [...messages, progress];

  const mapped = mapEventToChat(event);
  if (mapped.length === 0) return messages;
  return [...messages, ...mapped];
}

function extractProgressMessage(
  event: DOToCLIEvent,
  messages: ChatMessage[],
): ChatMessage | null {
  if (event.type !== "agent_event") return null;
  const raw = event.event;
  if (!isRecord(raw) || raw.type !== "message_update") return null;

  const heading = extractMarkdownHeading(readMessageDelta(raw));
  if (!heading) return null;
  if (messages.some((message) => message.variant === "progress" && message.content === heading)) {
    return null;
  }

  return {
    id: uid(),
    role: "system",
    variant: "progress",
    content: heading,
    timestamp: Date.now(),
  };
}

function projectActivity(activityLog: ActivityEntry[], event: DOToCLIEvent): ActivityEntry[] {
  if (event.type !== "agent_event") {
    const mapped = mapEventToActivity(event);
    return mapped.length === 0 ? activityLog : [...activityLog, ...mapped];
  }

  const raw = event.event;
  if (!isRecord(raw) || typeof raw.type !== "string") return activityLog;

  if (raw.type === "message_update") {
    const text = readMessageDelta(raw);
    if (!text) return activityLog;

    const last = activityLog[activityLog.length - 1];
    if (last?.kind === "thinking" && last.status === "running" && last.thinking) {
      return [
        ...activityLog.slice(0, -1),
        {
          ...last,
          timestamp: Date.now(),
          thinking: { text: last.thinking.text + text },
        },
      ];
    }

    return [
      ...activityLog,
      {
        id: uid(),
        kind: "thinking",
        status: "running",
        timestamp: Date.now(),
        thinking: { text },
      },
    ];
  }

  if (raw.type === "message_end") {
    const last = activityLog[activityLog.length - 1];
    if (last?.kind === "thinking" && last.status === "running") {
      return [
        ...activityLog.slice(0, -1),
        { ...last, status: "success", timestamp: Date.now() },
      ];
    }
    return activityLog;
  }

  if (raw.type === "tool_execution_end") {
    const name = readToolName(raw);
    const callId = readToolCallId(raw);
    const success = raw.success !== false && raw.isError !== true;
    const result =
      typeof raw.result === "string"
        ? raw.result
        : JSON.stringify(raw.result ?? "");
    const summary = summarizeTool(name, raw.args);
    const runningIndex = findRunningToolIndex(activityLog, name, summary, callId);

    if (runningIndex !== -1) {
      return activityLog.map((entry, index) =>
        index === runningIndex
          ? {
              ...entry,
              status: success ? "success" : "error",
              timestamp: Date.now(),
              tool: entry.tool
                ? {
                    ...entry.tool,
                    result,
                    error: !success && typeof raw.error === "string" ? raw.error : undefined,
                  }
                : entry.tool,
            }
          : entry,
      );
    }
  }

  const mapped = mapAgentEventToActivity(raw, Date.now());
  return mapped.length === 0 ? activityLog : [...activityLog, ...mapped];
}

function findRunningToolIndex(
  activityLog: ActivityEntry[],
  name: string,
  summary: string,
  callId: string | undefined,
): number {
  for (let index = activityLog.length - 1; index >= 0; index--) {
    const entry = activityLog[index];
    if (callId && entry.kind === "tool_call" && entry.tool?.callId === callId) {
      return index;
    }
    if (
      entry.kind === "tool_call" &&
      entry.status === "running" &&
      entry.tool?.name === name &&
      entry.tool.summary === summary
    ) {
      return index;
    }
  }
  return -1;
}

function readToolName(raw: Record<string, unknown>): string {
  if (typeof raw.tool === "string") return raw.tool;
  if (typeof raw.toolName === "string") return raw.toolName;
  return "unknown";
}

function readToolCallId(raw: Record<string, unknown>): string | undefined {
  return typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
}

function readMessageDelta(raw: Record<string, unknown>): string {
  if (typeof raw.content === "string") return raw.content;
  const assistantEvent = raw.assistantMessageEvent;
  if (isRecord(assistantEvent) && typeof assistantEvent.delta === "string") {
    return assistantEvent.delta;
  }
  return "";
}

function extractMarkdownHeading(text: string): string | null {
  const boldHeading = text.match(/(?:^|\n)\s*\*\*([^*\n]{4,120})\*\*/);
  if (boldHeading?.[1]) return cleanupHeading(boldHeading[1]);

  const markdownHeading = text.match(/(?:^|\n)\s*#{1,4}\s+(.{4,120})/);
  if (markdownHeading?.[1]) return cleanupHeading(markdownHeading[1]);

  return null;
}

function cleanupHeading(heading: string): string {
  return heading.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function isLowSignalTool(name: string): boolean {
  return name === "ls" || name === "find" || name === "grep" || name === "read";
}

function eventEntry(label: string, timestamp: number, detail?: string): ActivityEntry {
  return {
    id: uid(),
    kind: "event",
    status: "success",
    timestamp,
    event: { label, detail },
  };
}

function describeTurnEnd(raw: Record<string, unknown>): string | undefined {
  const toolResults = raw.toolResults;
  if (!Array.isArray(toolResults) || toolResults.length === 0) return undefined;
  return `${toolResults.length} tool result${toolResults.length === 1 ? "" : "s"}`;
}

function summarizeTool(name: string, args: unknown): string {
  if (!isRecord(args)) return name;

  switch (name) {
    case "read":
      return typeof args.path === "string" ? `Read ${args.path}` : name;
    case "bash":
      return typeof args.command === "string" ? `Run ${args.command}` : name;
    case "edit":
      return typeof args.path === "string" ? `Edit ${args.path}` : name;
    case "write":
      return typeof args.path === "string" ? `Write ${args.path}` : name;
    case "grep":
      return typeof args.pattern === "string" ? `Search ${args.pattern}` : name;
    case "find":
      if (typeof args.pattern === "string" && typeof args.path === "string") {
        return `Find ${args.pattern} in ${args.path}`;
      }
      if (typeof args.glob === "string") return `Find ${args.glob}`;
      return name;
    case "ls":
      return typeof args.path === "string" ? `List ${args.path}` : name;
    default:
      return name;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
