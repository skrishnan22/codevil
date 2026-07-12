import type { SlackThreadMessage } from "./client.js";
import { stripBotMention } from "./parser.js";

const MAX_AGENT_REQUEST_LENGTH = 20_000;

export interface FormatSlackAgentRequestInput {
  messages: SlackThreadMessage[];
  requesterId: string;
  explicitRequestTs: string;
  lastHandledMessageId?: string;
  botUserId: string;
}

export function formatSlackAgentRequest(input: FormatSlackAgentRequestInput): string {
  const messages = [...input.messages]
    .filter((message) => inContextSlice(message, input))
    .sort((left, right) => slackTimestamp(left.ts) - slackTimestamp(right.ts));
  const explicit = messages.find((message) => message.ts === input.explicitRequestTs);
  const explicitText = stripBotMention(explicit?.text ?? "", input.botUserId);
  const explicitLine = `Slack ${explicit?.user ?? input.requesterId}: ${explicitText}`;
  const prefix = "Source: Slack thread\n\nThread context:\n";
  const separator = "\n\nExplicit request:\n";
  const explicitBudget = MAX_AGENT_REQUEST_LENGTH - prefix.length - separator.length;
  const boundedExplicit = explicitLine.slice(0, explicitBudget);
  const contextBudget = MAX_AGENT_REQUEST_LENGTH
    - prefix.length
    - separator.length
    - boundedExplicit.length;
  const contextLines = messages
    .filter((message) => message.ts !== input.explicitRequestTs)
    .map(formatContextLine);
  const boundedContext = newestLinesWithinBudget(contextLines, contextBudget);

  return `${prefix}${boundedContext}${separator}${boundedExplicit}`;
}

function inContextSlice(
  message: SlackThreadMessage,
  input: FormatSlackAgentRequestInput,
): boolean {
  if (message.bot_id) return false;
  const timestamp = slackTimestamp(message.ts);
  if (timestamp > slackTimestamp(input.explicitRequestTs)) return false;
  if (
    input.lastHandledMessageId
    && timestamp <= slackTimestamp(input.lastHandledMessageId)
  ) return false;
  return Boolean(message.user && message.text);
}

function formatContextLine(message: SlackThreadMessage): string {
  return `Slack ${message.user}: ${message.text}`;
}

function newestLinesWithinBudget(lines: string[], budget: number): string {
  const kept: string[] = [];
  let remaining = budget;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (cost > remaining) continue;
    kept.unshift(line);
    remaining -= cost;
  }
  return kept.join("\n");
}

function slackTimestamp(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
