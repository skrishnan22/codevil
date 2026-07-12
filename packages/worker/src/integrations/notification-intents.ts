import type { DOToCLIEvent } from "@codevil/shared";

export type ExternalNotificationIntent =
  | { type: "agent_response"; runId: string; text: string }
  | { type: "approval_requested"; runId: string; plan: string }
  | { type: "question_asked"; runId: string; question: string }
  | { type: "run_failed"; runId: string; message: string };

export function externalNotificationIntent(
  event: DOToCLIEvent,
): ExternalNotificationIntent | null {
  switch (event.type) {
    case "agent_response":
      return { type: "agent_response", runId: event.run_id, text: event.text };
    case "approval_requested":
      return { type: "approval_requested", runId: event.run_id, plan: event.plan };
    case "question_raised":
      return {
        type: "question_asked",
        runId: event.run_id,
        question: event.question,
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
