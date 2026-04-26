import type { DOToCLIEvent } from "@codevil/shared";
import type { ChatMessage, ActivityEntry } from "../types";

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
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: event.line,
          timestamp: ts,
        },
      ];

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
    case "tool_execution_start": {
      const toolName = typeof raw.tool === "string" ? raw.tool : "unknown";
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
    case "message_update": {
      const content = typeof raw.content === "string" ? raw.content : "";
      return [
        {
          id: uid(),
          role: "assistant",
          variant: "text",
          content,
          timestamp: ts,
        },
      ];
    }
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
      const name = typeof raw.tool === "string" ? raw.tool : "unknown";
      return [
        {
          id: uid(),
          kind: "tool_call",
          status: "running",
          timestamp: ts,
          tool: {
            name,
            summary: summarizeTool(name, raw.args),
            args: raw.args ? JSON.stringify(raw.args) : undefined,
          },
        },
      ];
    }
    case "tool_execution_end": {
      const name = typeof raw.tool === "string" ? raw.tool : "unknown";
      const success = raw.success !== false;
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
      const text = typeof raw.content === "string" ? raw.content : "";
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
    default:
      return [];
  }
}

function summarizeTool(name: string, args: unknown): string {
  if (!isRecord(args)) return name;

  switch (name) {
    case "read":
      return typeof args.path === "string" ? args.path : name;
    case "bash":
      return typeof args.command === "string" ? args.command : name;
    case "edit":
      return typeof args.path === "string" ? `Edit ${args.path}` : name;
    case "write":
      return typeof args.path === "string" ? `Write ${args.path}` : name;
    case "grep":
      return typeof args.pattern === "string" ? `grep ${args.pattern}` : name;
    case "find":
      return typeof args.glob === "string" ? `find ${args.glob}` : name;
    case "ls":
      return typeof args.path === "string" ? `ls ${args.path}` : name;
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
