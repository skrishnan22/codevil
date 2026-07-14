import type { ExternalNotificationIntent } from "../notification-intents.js";
import type { SlackMessageContent } from "./client.js";

const MAX_EXTERNAL_TEXT_LENGTH = 500;
const MAX_SLACK_MARKDOWN_CHARS = 11_500;

export function renderSlackNotification(
  intent: ExternalNotificationIntent,
  sessionUrl: string,
): SlackMessageContent[] {
  const openSession = `Open session: ${sessionUrl}`;
  switch (intent.type) {
    case "agent_response": {
      const markdown = intent.text.replace(/\r\n?/g, "\n").trim();
      return splitSlackMarkdown(markdown).map((chunk) => ({
        text: markdownFallback(chunk),
        blocks: [{ type: "markdown", text: chunk }],
      }));
    }
    case "approval_requested":
      return [{ text: `Codevil needs plan approval:\n\n${boundedText(intent.plan)}\n\n${openSession}` }];
    case "question_asked":
      return [{ text: `Codevil needs input: ${boundedText(intent.question)} ${openSession}` }];
    case "run_failed":
      return [{ text: `Codevil could not complete the Agent Run: ${boundedText(intent.message)} ${openSession}` }];
  }
}

function splitSlackMarkdown(markdown: string): string[] {
  if (markdown.length <= MAX_SLACK_MARKDOWN_CHARS) return [markdown];

  const lines = markdown.split("\n").flatMap((line) => {
    if (line.length <= 10_000) return [line];
    const parts: string[] = [];
    for (let offset = 0; offset < line.length; offset += 10_000) {
      parts.push(line.slice(offset, offset + 10_000));
    }
    return parts;
  });
  const chunks: string[] = [];
  let current = "";
  let openFence: string | null = null;

  const pushCurrent = (): void => {
    if (!current) return;
    const closed = openFence ? `${current}\n\`\`\`` : current;
    chunks.push(closed);
    current = openFence ?? "";
  };

  for (const line of lines) {
    const separator = current ? "\n" : "";
    const reserveForFenceClose = openFence ? 4 : 0;
    if (current && current.length + separator.length + line.length + reserveForFenceClose > MAX_SLACK_MARKDOWN_CHARS) {
      pushCurrent();
    }

    current += `${current ? "\n" : ""}${line}`;
    if (/^\s*```/.test(line)) {
      openFence = openFence ? null : line.trim();
    }
  }

  if (current) {
    chunks.push(openFence ? `${current}\n\`\`\`` : current);
  }
  return chunks;
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
