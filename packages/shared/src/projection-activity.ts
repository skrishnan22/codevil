/**
 * Event → activity log mappers for session projection.
 */

import type { DOToCLIEvent } from "./messages-cli.js";
import { isRecord } from "./records.js";
import type { ActivityEntry, ProjectionContext } from "./projection-types.js";

export function mapEventToActivity(event: DOToCLIEvent, ctx: ProjectionContext): ActivityEntry[] {
  const ts = ctx.now;

  switch (event.type) {
    case "session_created":
      return [eventEntry("Room created", ts, ctx, event.session_id)];

    case "status":
      if (event.message === "Waiting for user approval.") return [];
      return [statusEventEntry(event.message, ts, ctx)];

    case "clone_progress":
      return [];

    case "room_ready":
      return [eventEntry("Room ready", ts, ctx, event.repo)];

    case "preview_starting":
      return [eventEntry("Preview starting", ts, ctx, event.command)];

    case "preview_ready":
      return [eventEntry("Preview ready", ts, ctx, event.url)];

    case "preview_error":
      return [eventEntry("Preview error", ts, ctx, event.message, "error")];

    case "phase":
      return [
        {
          id: ctx.uid(),
          kind: "phase_divider",
          status: "success",
          timestamp: ts,
          phase: {
            label: event.phase === "executing"
              ? `Agent turn with ${event.model}`
              : `${capitalize(event.phase)} with ${event.model}`,
          },
        },
      ];

    case "agent_event":
      return mapAgentEventToActivity(event.event, ts, ctx);

    case "agent_run_started":
      return [eventEntry("Agent run started", ts, ctx, event.text)];

    case "plan_execution_started":
      return [eventEntry("Plan approved", ts, ctx, "Starting execution.")];

    case "agent_run_completed":
      return [eventEntry("Agent finished", ts, ctx, event.pr_url)];

    case "agent_run_failed":
      return [eventEntry("Agent failed", ts, ctx, event.message, "error")];

    case "plan_revision_frozen":
      return [eventEntry("Plan revision frozen", ts, ctx, `Round ${event.round}`)];

    case "annotation_created":
      return [eventEntry("Plan annotation", ts, ctx, event.annotation.comment)];

    case "annotation_replied":
      return [eventEntry("Annotation reply", ts, ctx, event.reply.comment)];

    case "annotation_withdrawn":
      return [eventEntry("Annotation withdrawn", ts, ctx, event.thread_id)];

    case "consolidation_started":
      return [eventEntry("Consolidation started", ts, ctx, `Round ${event.round}`)];

    case "brief_dispatched":
      return [eventEntry("Brief dispatched", ts, ctx, "brief sent")];

    case "annotations_consumed":
      return [eventEntry("Annotations consumed", ts, ctx, `${event.thread_ids.length} annotations`)];

    default:
      return [];
  }
}

function mapAgentEventToActivity(raw: unknown, ts: number, ctx: ProjectionContext): ActivityEntry[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_start": {
      const name = readToolName(raw);
      return [
        {
          id: ctx.uid(),
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
          id: ctx.uid(),
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
          id: ctx.uid(),
          kind: "thinking",
          status: "running",
          timestamp: ts,
          thinking: { text },
        },
      ];
    }
    case "agent_start":
      return [eventEntry("Agent started", ts, ctx)];
    case "agent_end":
      return [eventEntry("Agent finished", ts, ctx)];
    case "turn_start":
      return [eventEntry("Turn started", ts, ctx)];
    case "turn_end":
      return [eventEntry("Turn finished", ts, ctx, describeTurnEnd(raw))];
    default:
      return [];
  }
}
export function appendProjectedActivity(activityLog: ActivityEntry[], event: DOToCLIEvent, ctx: ProjectionContext): ActivityEntry[] {
  if (event.type !== "agent_event") {
    const mapped = mapEventToActivity(event, ctx);
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
          timestamp: ctx.now,
          thinking: { text: last.thinking.text + text },
        },
      ];
    }

    return [
      ...activityLog,
      {
        id: ctx.uid(),
        kind: "thinking",
        status: "running",
        timestamp: ctx.now,
        thinking: { text },
      },
    ];
  }

  if (raw.type === "message_end") {
    const last = activityLog[activityLog.length - 1];
    if (last?.kind === "thinking" && last.status === "running") {
      return [
        ...activityLog.slice(0, -1),
        { ...last, status: "success", timestamp: ctx.now },
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
              timestamp: ctx.now,
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

  const mapped = mapAgentEventToActivity(raw, ctx.now, ctx);
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

function eventEntry(
  label: string,
  timestamp: number,
  ctx: ProjectionContext,
  detail?: string,
  status: ActivityEntry["status"] = "success",
): ActivityEntry {
  return {
    id: ctx.uid(),
    kind: "event",
    status,
    timestamp,
    event: { label, detail },
  };
}

function classifyStatusMessage(message: string): [string, string | undefined] {
  const normalized = message.toLowerCase();
  if (normalized.includes("provision")) return ["Provisioning sandbox", message];
  if (normalized.includes("sandbox") && normalized.includes("connect")) return ["Sandbox connected", message];
  if (normalized.includes("clone") || normalized.includes("cloned")) return ["Cloned repository", message];
  if (normalized.includes("setup") && normalized.includes("complete")) return ["Setup complete", message];
  if (normalized.includes("setup") || normalized.includes("install")) return ["Running setup", message];
  if (normalized.includes("approved")) return ["Plan approved", message];
  if (normalized.includes("verification")) return ["Verification", message];
  return [message, undefined];
}

function statusEventEntry(message: string, timestamp: number, ctx: ProjectionContext): ActivityEntry {
  const [label, detail] = classifyStatusMessage(message);
  return eventEntry(label, timestamp, ctx, detail);
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
