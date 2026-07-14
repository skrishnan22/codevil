import type { ExternalNotificationIntent } from "../notification-intents.js";
import type { SlackMessageContent } from "./client.js";

const MAX_EXTERNAL_TEXT_LENGTH = 500;

export function renderSlackNotification(
  intent: ExternalNotificationIntent,
  sessionUrl: string,
): SlackMessageContent[] {
  const openSession = `Open session: ${sessionUrl}`;
  switch (intent.type) {
    case "agent_response": {
      const markdown = intent.text.replace(/\r\n?/g, "\n").trim();
      return [{
        text: markdownFallback(markdown),
        blocks: [{ type: "markdown", text: markdown }],
      }];
    }
    case "approval_requested":
      return [{ text: `Codevil needs plan approval:\n\n${boundedText(intent.plan)}\n\n${openSession}` }];
    case "question_asked":
      return [{ text: `Codevil needs input: ${boundedText(intent.question)} ${openSession}` }];
    case "run_failed":
      return [{ text: `Codevil could not complete the Agent Run: ${boundedText(intent.message)} ${openSession}` }];
  }
}

function boundedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_EXTERNAL_TEXT_LENGTH);
}

function markdownFallback(value: string): string {
  const lines = value.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(trimmed)) return [];
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length >= 2) return [`${cells[0]}: ${cells.slice(1).join("; ")};`];
    }
    return [trimmed.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^[-*+]\s+/, "")];
  });

  return lines
    .join(" ")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/```[^\s]*|```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .trim()
    .slice(0, MAX_EXTERNAL_TEXT_LENGTH);
}
