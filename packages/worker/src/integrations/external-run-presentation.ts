import type { DOToCLIEvent } from "@codevil/shared";

export interface ExternalRunAction {
  id: string;
  label: string;
  status: "in_progress" | "complete" | "error";
}

export interface ExternalRunPresentation {
  runId: string;
  title: string;
  status: "in_progress" | "complete" | "error";
  phase: string;
  summary?: string;
  actions: ExternalRunAction[];
  waitingFor?: "question" | "approval";
  prUrl?: string;
}

export interface ExternalRunEvent {
  cursor: number;
  event: DOToCLIEvent;
}

const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 180;
const MAX_ACTIONS = 8;

export function createExternalRunPresentation(runId: string, requestText: string): ExternalRunPresentation {
  return {
    runId,
    title: boundedPublicText(requestText, MAX_TITLE_LENGTH) || "Agent Run",
    status: "in_progress",
    phase: "Starting",
    actions: [],
  };
}

export function projectExternalRunEvents(events: readonly ExternalRunEvent[]): ExternalRunPresentation {
  const started = events.find((entry) => entry.event.type === "agent_run_started");
  if (!started || started.event.type !== "agent_run_started") {
    throw new Error("Cannot project an Agent Run without agent_run_started");
  }

  let presentation = createExternalRunPresentation(started.event.run_id, started.event.text);
  for (const entry of events) {
    presentation = applyExternalRunEvent(presentation, entry.event, entry.cursor);
  }
  return presentation;
}

export function applyExternalRunEvent(
  current: ExternalRunPresentation,
  event: DOToCLIEvent,
  cursor: number,
): ExternalRunPresentation {
  if (event.type === "agent_run_started") {
    if (event.run_id !== current.runId) return current;
    return { ...current, title: boundedPublicText(event.text, MAX_TITLE_LENGTH) || current.title, phase: "Starting" };
  }

  if ("run_id" in event && event.run_id !== current.runId) return current;

  switch (event.type) {
    case "phase":
      return { ...current, phase: event.phase === "planning" ? "Preparing" : "Changing code", summary: undefined };
    case "status":
      return applyStatus(current, event.message);
    case "agent_event":
      return applyToolEvent(current, event.event, cursor);
    case "question_raised":
      return { ...current, phase: "Waiting for input", waitingFor: "question", summary: undefined };
    case "question_answered":
      return { ...current, waitingFor: undefined, phase: current.status === "in_progress" ? "Resuming" : current.phase };
    case "approval_requested":
      return { ...current, phase: "Waiting for approval", waitingFor: "approval", summary: undefined };
    case "plan_execution_started":
      return { ...current, waitingFor: undefined, phase: "Changing code", summary: undefined };
    case "agent_run_completed":
      return { ...current, status: "complete", phase: "Complete", summary: "Completed successfully.", waitingFor: undefined, ...(event.pr_url ? { prUrl: validPullRequestUrl(event.pr_url) } : {}) };
    case "agent_run_failed":
      return { ...current, status: "error", phase: "Failed", summary: boundedPublicText(event.message) || "The Agent Run failed.", waitingFor: undefined };
    default:
      return current;
  }
}

function applyStatus(current: ExternalRunPresentation, message: string): ExternalRunPresentation {
  const safe = boundedPublicText(message);
  const lower = safe.toLowerCase();
  const phase = lower.includes("verif")
    ? "Verifying"
    : lower.includes("pull request") || lower.includes("publishing") || lower.includes("creating")
      ? "Publishing"
      : current.phase;
  return { ...current, phase, ...(safe ? { summary: safe } : {}) };
}

function applyToolEvent(
  current: ExternalRunPresentation,
  rawEvent: unknown,
  cursor: number,
): ExternalRunPresentation {
  if (!isRecord(rawEvent)) return current;
  const type = typeof rawEvent.type === "string" ? rawEvent.type : "";
  if (type !== "tool_execution_start" && type !== "tool_execution_end") return current;

  const tool = typeof rawEvent.tool === "string"
    ? rawEvent.tool
    : typeof rawEvent.toolName === "string" ? rawEvent.toolName : "";
  const id = typeof rawEvent.toolCallId === "string" && rawEvent.toolCallId
    ? rawEvent.toolCallId
    : `tool_${cursor}`;
  const label = safeToolLabel(tool);
  if (!label) return current;

  const actionStatus = type === "tool_execution_start"
    ? "in_progress"
    : rawEvent.success === false || rawEvent.isError === true ? "error" : "complete";
  const actions = current.actions.filter((action) => action.id !== id);
  actions.push({ id, label, status: actionStatus });
  return {
    ...current,
    actions: actions.slice(-MAX_ACTIONS),
    phase: phaseForAction(label, current.phase),
    summary: undefined,
  };
}

function safeToolLabel(tool: string): string | null {
  const name = tool.toLowerCase();
  if (/(read|cat|head|tail|grep|rg|glob|find|list|search|inspect)/.test(name)) return "Investigating repository";
  if (/(edit|write|patch|replace|mkdir|move|delete|remove)/.test(name)) return "Changing code";
  if (/(test|typecheck|build|lint|check)/.test(name)) return "Running checks";
  if (/(commit|push|pull.?request|pr|publish)/.test(name)) return "Publishing changes";
  if (/(bash|shell|exec|command|run)/.test(name)) return "Running command";
  return null;
}

function phaseForAction(label: string, fallback: string): string {
  if (label === "Investigating repository") return "Investigating";
  if (label === "Changing code") return "Changing code";
  if (label === "Running checks") return "Verifying";
  if (label === "Publishing changes") return "Publishing";
  return fallback;
}

export function validPullRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && /^\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url.pathname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedPublicText(value: string, maxLength = MAX_SUMMARY_LENGTH): string {
  return value
    .replace(/(?:gh[pousr]_|sk-[a-z0-9_-]{8,}|(?:api[_-]?key|token|secret|password)=)[^\s]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const EXTERNAL_RUN_ACTION_LIMIT = MAX_ACTIONS;
export const EXTERNAL_RUN_TITLE_LIMIT = MAX_TITLE_LENGTH;
