import type { DOToCLIEvent } from "@codevil/shared";

export type ExternalNotificationIntent =
  | { type: "run_started"; runId: string }
  | { type: "approval_requested"; runId: string }
  | { type: "question_asked"; runId: string; question: string }
  | { type: "run_completed"; runId: string; pullRequestUrl?: string }
  | { type: "run_failed"; runId: string; message: string };

export function externalNotificationIntent(
  event: DOToCLIEvent,
): ExternalNotificationIntent | null {
  switch (event.type) {
    case "agent_run_started":
      return { type: "run_started", runId: event.run_id };
    case "approval_requested":
      return { type: "approval_requested", runId: event.run_id };
    case "question_raised":
      return {
        type: "question_asked",
        runId: event.run_id,
        question: event.question,
      };
    case "agent_run_completed":
      return {
        type: "run_completed",
        runId: event.run_id,
        ...(event.pr_url ? { pullRequestUrl: event.pr_url } : {}),
      };
    case "agent_run_failed":
      return {
        type: "run_failed",
        runId: event.run_id,
        message: event.message,
      };
    default:
      return null;
  }
}
