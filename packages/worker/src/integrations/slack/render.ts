import type { ExternalNotificationIntent } from "../notification-intents.js";

const MAX_EXTERNAL_TEXT_LENGTH = 500;

export function renderSlackNotification(
  intent: ExternalNotificationIntent,
  sessionUrl: string,
): string {
  const openSession = `Open session: ${sessionUrl}`;
  switch (intent.type) {
    case "agent_response":
      return renderSlackMrkdwn(intent.text);
    case "approval_requested":
      return `Codevil needs plan approval:\n\n${boundedText(intent.plan)}\n\n${openSession}`;
    case "question_asked":
      return `Codevil needs input: ${boundedText(intent.question)} ${openSession}`;
    case "run_failed":
      return `Codevil could not complete the Agent Run: ${boundedText(intent.message)} ${openSession}`;
  }
}

function boundedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_EXTERNAL_TEXT_LENGTH);
}

function renderSlackMrkdwn(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^[ \t]*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n");
}
