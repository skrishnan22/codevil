import type { DOToCLIEvent, QuestionOption } from "@codevil/shared";

export type ExternalNotificationIntent =
  | { type: "agent_response"; runId: string; text: string }
  | { type: "approval_requested"; runId: string; plan: string }
  | {
      type: "question_asked";
      requestId: string;
      runId: string;
      question: string;
      context?: string;
      options?: QuestionOption[];
      allowFreeform: boolean;
      allowMultiple: boolean;
    }
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
        requestId: event.request_id,
        runId: event.run_id,
        question: event.question,
        ...(event.context !== undefined ? { context: event.context } : {}),
        ...(event.options !== undefined ? { options: event.options } : {}),
        allowFreeform: event.allow_freeform,
        allowMultiple: event.allow_multiple,
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
