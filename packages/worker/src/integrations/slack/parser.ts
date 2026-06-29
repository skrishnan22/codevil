import { z } from "../../../../shared/node_modules/zod/index.js";

export const SlackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string(),
});

export const SlackEventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    event_id: z.string().optional(),
    team_id: z.string().optional(),
    event: z
      .object({
        type: z.string(),
        text: z.string().optional(),
        user: z.string().optional(),
        channel: z.string().optional(),
        ts: z.string().optional(),
        thread_ts: z.string().optional(),
        bot_id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CodevilSlashCommand =
  | { type: "set_repo"; repoUrl: string }
  | { type: "repo" }
  | { type: "clear_repo" }
  | { type: "help" };

export function stripBotMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text;
  return text.replace(botMentionPattern(botUserId), " ").replace(/\s+/g, " ").trim();
}

export function slackThreadRootTs({ ts, thread_ts }: { ts: string; thread_ts?: string }): string {
  return thread_ts ?? ts;
}

export function containsBotMention(text: string | undefined, botUserId: string | undefined): boolean {
  if (!text || !botUserId) return false;
  return botMentionPattern(botUserId).test(text);
}

export function parseCodevilSlashCommand(text: string): CodevilSlashCommand {
  const trimmed = text.trim();
  if (!trimmed) return { type: "help" };

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command === "set-repo" && rest[0]) return { type: "set_repo", repoUrl: rest[0] };
  if (command === "repo" && rest.length === 0) return { type: "repo" };
  if (command === "clear-repo" && rest.length === 0) return { type: "clear_repo" };
  return { type: "help" };
}

function botMentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, "g");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
