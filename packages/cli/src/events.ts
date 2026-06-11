import type { DOToCLIEvent } from "@codevil/shared";
import { PersistedDOToCLIEventSchema, parseInbound } from "@codevil/shared";

export interface EventEnvelope {
  cursor: number;
  event: DOToCLIEvent;
}

export function parseEnvelope(raw: string): EventEnvelope | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.cursor !== "number") {
    throw new Error("Invalid event envelope");
  }

  // Lenient: CLI may be older than the DO and see event types it doesn't
  // know about; we still want a tagged object so render code can branch.
  const event = parseInbound(PersistedDOToCLIEventSchema, parsed.event, "do_to_cli");
  if (!event) return null;

  return {
    cursor: parsed.cursor,
    event: event as unknown as DOToCLIEvent,
  };
}

export function renderEvent(event: DOToCLIEvent): string[] {
  switch (event.type) {
    case "session_created":
      return [`Session created: ${event.session_id}`];
    case "status":
      return [event.message];
    case "clone_progress":
      return [event.line];
    case "phase":
      return [`Phase: ${event.phase} (${event.model})`];
    case "agent_event":
      return renderAgentEvent(event.event);
    case "plan_ready":
      return [
        "",
        ...event.plan.split("\n"),
        "",
        `Cost: $${event.cost.total_cost_usd.toFixed(2)} (${event.cost.input_tokens} input tokens, ${event.cost.output_tokens} output tokens)`,
        `Refinement round: ${event.refinement_round}`,
        "",
      ];
    case "verification_failed":
      return [
        `Verification failed after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}.`,
        event.last_error,
      ];
    case "complete":
      return [`Completed. Draft PR: ${event.pr_url}`];
    case "error":
      return [`Error: ${event.message}`];
    case "preview_starting":
      return [`Starting preview: ${event.command} on port ${event.port}`];
    case "preview_ready":
      return [`Preview ready: ${event.url}`];
    case "preview_error":
      return [`Preview error: ${event.message}`];
    case "preview_stopped":
      return ["Preview stopped."];
    case "preview_apps":
      if (event.apps.length === 0) return [];
      return [`Detected preview apps: ${event.apps.map((app) => app.key).join(", ")}`];
    default:
      return [];
  }
}

export function isCompletionEvent(event: DOToCLIEvent): boolean {
  return event.type === "complete";
}

function renderAgentEvent(event: unknown): string[] {
  if (isRecord(event) && typeof event.type === "string") {
    return [`Agent: ${event.type}`];
  }
  return ["Agent event received"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
