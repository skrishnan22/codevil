import type { SessionSummary } from "@/types";

export type SessionStatus = "running" | "review" | "done" | "failed" | "idle";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  review: "Review",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

export function deriveStatus(session: SessionSummary): SessionStatus {
  if (session.room_state === "failed" || session.sandbox_state === "failed") return "failed";
  switch (session.active_run_state) {
    case "completed":
      return "done";
    case "awaiting_approval":
    case "verifying":
    case "publishing":
      return "review";
    case "queued":
    case "thinking":
    case "executing":
      return "running";
    case "failed":
      return "failed";
    default:
      break;
  }
  if (["provisioning", "cloning", "not_started"].includes(session.sandbox_state)) return "running";
  return "idle";
}

/**
 * A session is "active" while it still has work in flight or is waiting on a
 * decision: the agent is running, or the run is awaiting review. Terminal
 * sessions (done/failed/archived) are not active.
 */
export function isActiveSession(session: SessionSummary): boolean {
  if (session.room_state === "archived" || session.room_state === "failed") return false;
  const status = deriveStatus(session);
  return status === "running" || status === "review";
}

/** Active sessions other than the one currently open, most recent first. */
export function filterOtherActiveSessions(
  sessions: SessionSummary[],
  currentSessionId: string | null,
): SessionSummary[] {
  return sessions
    .filter((session) => session.id !== currentSessionId && isActiveSession(session))
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
}