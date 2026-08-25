import type { DOToCLIEvent } from "@codevil/shared";

export interface ExternalRunStep {
  id: string;
  label: string;
  detail?: string;
  status: "active" | "done" | "error";
  rank: number;
}

export interface ExternalRunPresentation {
  runId: string;
  title: string;
  status: "in_progress" | "complete" | "error";
  phase: string;
  summary?: string;
  steps: ExternalRunStep[];
  /** Completed steps that fell off the kept window (used for a subtle footer). */
  droppedSteps: number;
  waitingFor?: "question" | "approval";
  prUrl?: string;
  /** Set when the run is queued behind an active run. */
  queuedPosition?: number;
}

export interface ExternalRunEvent {
  cursor: number;
  event: DOToCLIEvent;
}

const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 180;
const MAX_DETAIL_LENGTH = 60;
/** Internal cap so the render fingerprint stays bounded; rendering windows further. */
const MAX_KEPT_STEPS = 10;
export const MAX_VISIBLE_STEPS = 4; // current step + up to 3 older

export function createExternalRunPresentation(runId: string, requestText: string): ExternalRunPresentation {
  return {
    runId,
    title: boundedPublicText(requestText, MAX_TITLE_LENGTH) || "Agent Run",
    status: "in_progress",
    phase: "Starting",
    steps: [],
    droppedSteps: 0,
  };
}

export function projectExternalRunEvents(events: readonly ExternalRunEvent[]): ExternalRunPresentation {
  const start = events.find((entry) =>
    entry.event.type === "agent_request" || entry.event.type === "agent_run_started");
  if (!start || (start.event.type !== "agent_request" && start.event.type !== "agent_run_started")) {
    throw new Error("Cannot project an Agent Run without agent_request or agent_run_started");
  }

  const presentation = createExternalRunPresentation(start.event.run_id, start.event.text);
  let next = presentation;
  for (const entry of events) {
    next = applyExternalRunEvent(next, entry.event, entry.cursor);
  }
  return next;
}

export function applyExternalRunEvent(
  current: ExternalRunPresentation,
  event: DOToCLIEvent,
  cursor: number,
): ExternalRunPresentation {
  if (event.type === "agent_request" || event.type === "agent_run_started") {
    if (event.run_id !== current.runId) return current;
    return {
      ...current,
      title: boundedPublicText(event.text, MAX_TITLE_LENGTH) || current.title,
      phase: "Starting",
      queuedPosition: undefined,
    };
  }

  if (event.type === "agent_request_queued") {
    if (event.run_id !== current.runId) return current;
    return { ...current, phase: "Queued", queuedPosition: event.position, summary: undefined };
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
      return {
        ...current,
        status: "complete",
        phase: "Complete",
        summary: "Completed successfully.",
        waitingFor: undefined,
        queuedPosition: undefined,
        ...(event.pr_url ? { prUrl: validPullRequestUrl(event.pr_url) } : {}),
      };
    case "agent_run_failed":
      return {
        ...current,
        status: "error",
        phase: "Failed",
        summary: failureSummary(event.message),
        waitingFor: undefined,
        queuedPosition: undefined,
      };
    default:
      return current;
  }
}

function applyStatus(current: ExternalRunPresentation, message: string): ExternalRunPresentation {
  const lower = message.toLowerCase();
  if (lower.includes("verif") || lower.includes("test") || lower.includes("check")) {
    return { ...current, phase: "Verifying", summary: "Running verification checks." };
  }
  if (lower.includes("pull request") || lower.includes("publishing") || lower.includes("creating")) {
    return { ...current, phase: "Publishing", summary: "Publishing changes." };
  }
  if (lower.includes("execution") || lower.includes("plan approved")) {
    return { ...current, phase: "Changing code", summary: "Applying changes." };
  }
  if (lower.includes("clone") || lower.includes("sandbox") || lower.includes("setup") || lower.includes("repository")) {
    return { ...current, phase: "Preparing", summary: "Preparing the repository." };
  }
  return current;
}

function failureSummary(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("verif") || lower.includes("test") || lower.includes("check")) return "Verification failed.";
  if (lower.includes("timeout") || lower.includes("timed out")) return "The Agent Run timed out.";
  return "The Agent Run failed.";
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

  if (type === "tool_execution_start") {
    const step: ExternalRunStep = {
      id,
      label,
      detail: toolDetail(label, rawEvent),
      status: "active",
      rank: cursor,
    };
    const steps = [...current.steps.filter((existing) => existing.id !== id), step];
    let droppedSteps = current.droppedSteps;
    if (steps.length > MAX_KEPT_STEPS) {
      droppedSteps += steps.length - MAX_KEPT_STEPS;
    }
    return {
      ...current,
      steps: steps.slice(-MAX_KEPT_STEPS),
      droppedSteps,
      phase: phaseForAction(label, current.phase),
      summary: undefined,
    };
  }

  const actionStatus: ExternalRunStep["status"] =
    rawEvent.success === false || rawEvent.isError === true ? "error" : "done";
  const existing = current.steps.find((step) => step.id === id);
  if (!existing) {
    // Tolerate a dropped/missed start event: surface the completed tool call.
    const step: ExternalRunStep = {
      id,
      label,
      detail: toolDetail(label, rawEvent),
      status: actionStatus,
      rank: cursor,
    };
    const steps = [...current.steps, step];
    let droppedSteps = current.droppedSteps;
    if (steps.length > MAX_KEPT_STEPS) {
      droppedSteps += steps.length - MAX_KEPT_STEPS;
    }
    return {
      ...current,
      steps: steps.slice(-MAX_KEPT_STEPS),
      droppedSteps,
      phase: phaseForAction(label, current.phase),
      summary: undefined,
    };
  }
  const steps = current.steps.map((step) =>
    step.id === id ? { ...step, status: actionStatus } : step);
  return {
    ...current,
    steps,
    phase: phaseForAction(label, current.phase),
    summary: undefined,
  };
}

function safeToolLabel(tool: string): string | null {
  const name = tool.toLowerCase();
  if (/(ask_question|ask)$/.test(name)) return "Asking you something";
  if (/(web_search|websearch|fetch_url|url_fetch|http)/.test(name)) return "Fetching web content";
  if (/(read|cat|head|tail)$/.test(name)) return "Reading files";
  if (/(grep|rg|search)/.test(name)) return "Searching code";
  if (/(glob|find|ls|list|explore)/.test(name)) return "Exploring files";
  if (/(edit|write|patch|replace|apply)/.test(name)) return "Editing code";
  if (/(mkdir|move|delete|remove|rm|rename)/.test(name)) return "Changing files";
  if (/(test|typecheck|build|lint|check)/.test(name)) return "Running checks";
  if (/(commit|push|pull.?request|publish)/.test(name)) return "Publishing changes";
  if (/(bash|shell|exec|run_command)/.test(name)) return "Running commands";
  return `Calling ${tool}`;
}

function toolDetail(label: string, rawEvent: Record<string, unknown>): string | undefined {
  const args = isRecord(rawEvent.args) ? rawEvent.args : {};
  const pathValue = typeof args.file_path === "string"
    ? args.file_path
    : typeof args.path === "string"
      ? args.path
      : typeof args.file === "string" ? args.file : undefined;
  if (label === "Reading files" || label === "Editing code" || label === "Changing files" || label === "Exploring files") {
    if (pathValue) return safeDetail(basename(pathValue));
  }
  if (label === "Searching code" && typeof args.pattern === "string") {
    return safeDetail(args.pattern);
  }
  return undefined;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? value;
}

/** Details shown on a public card: redact tokens and secret-ish words. */
function safeDetail(value: string): string {
  return boundedPublicText(value, MAX_DETAIL_LENGTH)
    .replace(/\b(secret|password|token|api[_-]?key|credential)s?\b/gi, "[REDACTED]");
}

function phaseForAction(label: string, fallback: string): string {
  if (label === "Reading files" || label === "Searching code" || label === "Exploring files") return "Investigating";
  if (label === "Editing code" || label === "Changing files") return "Changing code";
  if (label === "Running checks") return "Verifying";
  if (label === "Publishing changes") return "Publishing";
  if (label === "Running commands" || label === "Asking you something" || label === "Fetching web content") return fallback;
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

export const EXTERNAL_RUN_TITLE_LIMIT = MAX_TITLE_LENGTH;