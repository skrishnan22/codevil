import type { DOToCLIEvent } from "@codevil/shared";
import { workerLogForSession, workerLogSessionException } from "../logging.js";
import {
  dedupeEventInsert,
  externalConversationDestinationBySessionSelect,
} from "./store.js";
import type { ExternalConversationDestination } from "./types.js";
import { externalNotificationIntent } from "./notification-intents.js";
import {
  createSlackWebApi,
  postSlackMessage,
  type SlackApi,
} from "./slack/client.js";
import { renderSlackNotification } from "./slack/render.js";

export interface ExternalNotificationDeps {
  slackApi?: SlackApi;
}

export interface ExternalNotificationEnv {
  DB: D1Database;
  SLACK_BOT_TOKEN?: string;
}

export async function notifyExternalConversation(
  input: {
    env: ExternalNotificationEnv;
    sessionId: string;
    workerOrigin: string;
    cursor: number;
    event: DOToCLIEvent;
  },
  deps: ExternalNotificationDeps = {},
): Promise<void> {
  const intent = externalNotificationIntent(input.event);
  if (!intent) return;

  try {
    const destination = await firstDestination(input.env.DB, input.sessionId);
    if (!destination) return;

    const claimed = dedupeEventInsert(
      `outbound:${input.sessionId}:${input.cursor}`,
      destination.integration_id,
      null,
      new Date().toISOString(),
    );
    const claim = await input.env.DB
      .prepare(claimed.sql)
      .bind(...claimed.bindings)
      .run();
    if (Number(claim.meta.changes ?? 0) === 0) return;

    if (destination.provider !== "slack" || !input.env.SLACK_BOT_TOKEN) return;
    const api = deps.slackApi ?? createSlackWebApi();
    const sessionUrl = `${input.workerOrigin.replace(/\/+$/, "")}/sessions/${input.sessionId}`;
    const result = await postSlackMessage(api, input.env.SLACK_BOT_TOKEN, {
      channel: destination.external_channel_id,
      threadTs: destination.external_conversation_id,
      text: renderSlackNotification(intent, sessionUrl),
    });
    if (!result.ok) {
      workerLogForSession(input.sessionId, "WARN", "external_notification.delivery.failed", {
        provider: destination.provider,
        error: result.error,
        cursor: input.cursor,
      });
    }
  } catch (error) {
    workerLogSessionException(input.sessionId, "external_notification.delivery.failed", error, {
      cursor: input.cursor,
      event_type: input.event.type,
    });
  }
}

async function firstDestination(
  db: D1Database,
  sessionId: string,
): Promise<ExternalConversationDestination | null> {
  const select = externalConversationDestinationBySessionSelect(sessionId);
  return db.prepare(select.sql).bind(...select.bindings).first<ExternalConversationDestination>();
}
