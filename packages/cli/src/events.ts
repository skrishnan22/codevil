import type { DOToCLIEvent } from "@codevil/shared";
import {
  isRecord,
  parseReplayEvent,
  ReplayBatchFrameSchema,
  SnapshotFrameSchema,
} from "@codevil/shared";

export interface EventEnvelope {
  cursor: number;
  event: DOToCLIEvent;
}

// Discriminated result type for parseEnvelope, covering the three wire-frame shapes.
export type ParsedFrame =
  | { kind: "envelope"; cursor: number; event: DOToCLIEvent }
  | { kind: "snapshot"; cursor: number }
  | { kind: "replay_batch"; events: Array<{ cursor: number; event: DOToCLIEvent }> }
  | { kind: "unknown" };

export function parseEnvelope(raw: string): EventEnvelope | null {
  const frame = parseFrame(raw);
  if (frame.kind === "envelope") {
    return { cursor: frame.cursor, event: frame.event };
  }
  // snapshot and replay_batch frames are not EventEnvelopes.
  // Return null to signal "no single event to render" — the caller should
  // use parseFrame directly when it needs to handle all frame kinds.
  return null;
}

/**
 * Parses any wire frame the DO may send.  Handles all three shapes:
 *   - { type: "snapshot", ... }        → kind: "snapshot"
 *   - { type: "replay_batch", ... }    → kind: "replay_batch"
 *   - { cursor: number, event: {...} } → kind: "envelope"
 *
 * Returns kind: "unknown" for valid JSON that doesn't match any known shape
 * (forward-compat: drop silently instead of crashing).
 *
 * Throws Error("Invalid event envelope") only for the legacy {cursor,event}
 * shape that is structurally malformed — preserving the existing contract for
 * callers that rely on the throw for truly bad data.
 */
export function parseFrame(raw: string): ParsedFrame {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid event envelope");
  }

  // --- snapshot frame ---
  if (parsed.type === "snapshot") {
    const result = SnapshotFrameSchema.safeParse(parsed);
    if (!result.success) {
      // Malformed snapshot frame — silently drop rather than throw.
      return { kind: "unknown" };
    }
    // The CLI is streaming-oriented; for a snapshot frame we just consume it
    // and advance the cursor. Subsequent replay_batch delivers the event tail.
    return { kind: "snapshot", cursor: result.data.cursor };
  }

  // --- replay_batch frame ---
  if (parsed.type === "replay_batch") {
    const result = ReplayBatchFrameSchema.safeParse(parsed);
    if (!result.success) {
      return { kind: "unknown" };
    }
    // Each item is validated leniently (same as the legacy per-envelope path).
    const events: Array<{ cursor: number; event: DOToCLIEvent }> = [];
    for (const item of result.data.events) {
      const event = parseReplayEvent(item.event);
      if (event) {
        events.push({ cursor: item.cursor, event });
      }
    }
    return { kind: "replay_batch", events };
  }

  // --- legacy {cursor, event} envelope ---
  if (typeof parsed.cursor !== "number") {
    throw new Error("Invalid event envelope");
  }

  const event = parseReplayEvent(parsed.event);
  if (!event) return { kind: "unknown" };

  return {
    kind: "envelope",
    cursor: parsed.cursor,
    event,
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
