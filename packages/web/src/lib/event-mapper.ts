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
          actor: event.actor,
        },
      ];

    case "clone_progress":
      return [];

    case "phase":
      return [];

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

    case "approval_requested":
      return [
        {
          id: uid(),
          role: "assistant",
          variant: "plan",
          content: event.plan,
          timestamp: ts,
          meta: {
            run_id: event.run_id,
            cost: event.cost,
            refinement_round: event.refinement_round,
          },
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
          actor: event.actor,
        },
      ];

    case "preview_starting":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `Starting preview: ${event.command}`,
          timestamp: ts,
        },
      ];

    case "preview_ready":
      return [];

    case "preview_error":
      return [
        {
          id: uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
        },
      ];

    case "preview_stopped":
      return [];

    case "preview_apps":
      return [];

    case "room_ready":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `Room ready for ${event.repo}`,
          timestamp: ts,
        },
      ];

    case "participant_joined":
    case "participant_left":
      return [];

    case "human_message":
      return [
        {
          id: event.id,
          role: "user",
          variant: "text",
          content: event.text,
          timestamp: Date.parse(event.created_at) || ts,
          actor: event.actor.name,
          meta: { actor_id: event.actor.id },
        },
      ];

    case "agent_request":
      return [
        {
          id: event.run_id,
          role: "user",
          variant: "text",
          content: `@codevil ${event.text}`,
          timestamp: Date.parse(event.created_at) || ts,
          actor: event.actor.name,
          meta: { actor_id: event.actor.id, run_id: event.run_id },
        },
      ];

    case "agent_request_queued":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `Queued agent request #${event.position}.`,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_run_started":
      return [];

    case "agent_response":
      return [
        {
          id: uid(),
          role: "assistant",
          variant: "text",
          content: event.text,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_run_completed":
      return [];

    case "agent_run_failed":
      return [
        {
          id: uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_event":
      return mapAgentEventToChat(event.event);

    case "plan_revision_frozen":
      return [];

    case "annotation_created":
      return [
        {
          id: event.annotation.id,
          role: "system",
          variant: "status",
          content: `${event.annotation.author.name} annotated the plan: ${event.annotation.comment}`,
          timestamp: Date.parse(event.annotation.created_at) || ts,
          actor: event.annotation.author.name,
          meta: { run_id: event.annotation.run_id, refinement_round: event.annotation.round },
        },
      ];

    case "annotation_replied":
      return [
        {
          id: event.reply.id,
          role: "system",
          variant: "status",
          content: `${event.reply.author.name} replied to an annotation: ${event.reply.comment}`,
          timestamp: Date.parse(event.reply.created_at) || ts,
          actor: event.reply.author.name,
        },
      ];

    case "annotation_withdrawn":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `${event.withdrawn_by.name} withdrew an annotation.`,
          timestamp: Date.parse(event.withdrawn_at) || ts,
          actor: event.withdrawn_by.name,
        },
      ];

    case "consolidation_started":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: "Consolidating plan feedback.",
          timestamp: ts,
          meta: { run_id: event.run_id, refinement_round: event.round },
        },
      ];

    case "conflict_raised":
      return [
        {
          id: event.conflict.id,
          role: "system",
          variant: "status",
          content: `Conflict needs a decision: ${event.conflict.summary}`,
          timestamp: ts,
          meta: { run_id: event.conflict.run_id, refinement_round: event.conflict.round },
        },
      ];

    case "conflict_resolved":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `${event.resolved_by.name} resolved a plan feedback conflict.`,
          timestamp: ts,
          actor: event.resolved_by.name,
        },
      ];

    case "brief_dispatched":
      return [
        {
          id: uid(),
          role: "system",
          variant: "status",
          content: `Refinement brief dispatched with ${event.brief_items.length} item${event.brief_items.length === 1 ? "" : "s"}.`,
          timestamp: ts,
          meta: { run_id: event.run_id, refinement_round: event.to_round },
        },
      ];

    case "annotations_consumed":
      return [];

    case "question_raised":
    case "question_answered":
      return [];
  }
}

function mapAgentEventToChat(raw: unknown): ChatMessage[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_end":
    case "message_update":
      return [];
    default:
      return [];
  }
}

export function mapEventToActivity(event: DOToCLIEvent): ActivityEntry[] {
  const ts = Date.now();

  switch (event.type) {
    case "session_created":
      return [eventEntry("Room created", ts, event.session_id)];

    case "status":
      if (event.message === "Waiting for user approval.") return [];
      return [statusEventEntry(event.message, ts)];

    case "clone_progress":
      return [];

    case "room_ready":
      return [eventEntry("Room ready", ts, event.repo)];

    case "preview_starting":
      return [eventEntry("Preview starting", ts, event.command)];

    case "preview_ready":
      return [eventEntry("Preview ready", ts, event.url)];

    case "preview_error":
      return [eventEntry("Preview error", ts, event.message, "error")];

    case "phase":
      return [
        {
          id: uid(),
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
      return mapAgentEventToActivity(event.event, ts);

    case "agent_run_started":
      return [eventEntry("Agent run started", ts, event.text)];

    case "agent_run_completed":
      return [eventEntry("Agent finished", ts, event.pr_url)];

    case "agent_run_failed":
      return [eventEntry("Agent failed", ts, event.message, "error")];

    case "plan_revision_frozen":
      return [eventEntry("Plan revision frozen", ts, `Round ${event.round}`)];

    case "annotation_created":
      return [eventEntry("Plan annotation", ts, event.annotation.comment)];

    case "annotation_replied":
      return [eventEntry("Annotation reply", ts, event.reply.comment)];

    case "annotation_withdrawn":
      return [eventEntry("Annotation withdrawn", ts, event.thread_id)];

    case "consolidation_started":
      return [eventEntry("Consolidation started", ts, `Round ${event.round}`)];

    case "conflict_raised":
      return [eventEntry("Conflict raised", ts, event.conflict.summary)];

    case "conflict_resolved":
      return [eventEntry("Conflict resolved", ts, event.conflict_id)];

    case "brief_dispatched":
      return [eventEntry("Brief dispatched", ts, `${event.brief_items.length} items`)];

    case "annotations_consumed":
      return [eventEntry("Annotations consumed", ts, `${event.thread_ids.length} annotations`)];

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
  const mapped = mapEventToChat(event);
  if (mapped.length === 0) return messages;
  return [...messages, ...mapped];
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

function eventEntry(
  label: string,
  timestamp: number,
  detail?: string,
  status: ActivityEntry["status"] = "success",
): ActivityEntry {
  return {
    id: uid(),
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

function statusEventEntry(message: string, timestamp: number): ActivityEntry {
  const [label, detail] = classifyStatusMessage(message);
  return eventEntry(label, timestamp, detail);
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
