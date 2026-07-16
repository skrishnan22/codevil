import type { DOToCLIEvent } from "@codevil/shared";
import { workerLogForSession, workerLogSessionException } from "../logging.js";
import {
  dedupeEventInsert,
  externalMessageDedupeDelete,
  externalConversationDestinationBySessionSelect,
} from "./store.js";
import type { ExternalConversationDestination } from "./types.js";
import { externalNotificationIntent } from "./notification-intents.js";
import {
  createSlackWebApi,
  postSlackMessage,
  type SlackApi,
  type SlackApiResult,
} from "./slack/client.js";
import { renderSlackNotification } from "./slack/render.js";

export interface ExternalNotificationDeps {
  slackApi?: SlackApi;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface ExternalNotificationEnv {
  DB: D1Database;
  SLACK_BOT_TOKEN?: string;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRY_JITTER_MS = 250;

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
    if (destination.provider !== "slack" || !input.env.SLACK_BOT_TOKEN) return;

    const externalEventId = `outbound:${input.sessionId}:${input.cursor}`;
    const claimed = dedupeEventInsert(
      externalEventId,
      destination.integration_id,
      null,
      new Date().toISOString(),
    );
    const claim = await input.env.DB
      .prepare(claimed.sql)
      .bind(...claimed.bindings)
      .run();
    if (Number(claim.meta.changes ?? 0) === 0) return;

    const api = deps.slackApi ?? createSlackWebApi();
    const sleep = deps.sleep ?? sleepFor;
    const random = deps.random ?? Math.random;
    const sessionUrl = `${input.workerOrigin.replace(/\/+$/, "")}/sessions/${input.sessionId}`;
    const messages = renderSlackNotification(intent, sessionUrl);
    for (const [messageIndex, message] of messages.entries()) {
      const result = await postSlackMessageWithRetry({
        api,
        botToken: input.env.SLACK_BOT_TOKEN,
        channelId: destination.external_channel_id,
        threadTs: destination.external_conversation_id,
        message,
        sleep,
        random,
        log: (severity, event, attributes) => workerLogForSession(input.sessionId, severity, event, {
          provider: destination.provider,
          cursor: input.cursor,
          event_type: input.event.type,
          ...(input.event.type === "question_raised" ? { request_id: input.event.request_id } : {}),
          channel_id: destination.external_channel_id,
          thread_ts: destination.external_conversation_id,
          message_index: messageIndex,
          message_count: messages.length,
          ...attributes,
        }),
      });
      if (!result.ok) {
        if (messageIndex === 0) {
          const release = externalMessageDedupeDelete(destination.integration_id, externalEventId);
          await input.env.DB.prepare(release.sql).bind(...release.bindings).run();
        }
        return;
      }
    }
  } catch (error) {
    workerLogSessionException(input.sessionId, "external_notification.delivery.failed", error, {
      cursor: input.cursor,
      event_type: input.event.type,
    });
  }
}

interface RetrySlackMessageInput {
  api: SlackApi;
  botToken: string;
  channelId: string;
  threadTs: string;
  message: ReturnType<typeof renderSlackNotification>[number];
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
  log: (
    severity: "DEBUG" | "INFO" | "WARN" | "ERROR",
    event: string,
    attributes: Record<string, unknown>,
  ) => void;
}

async function postSlackMessageWithRetry(input: RetrySlackMessageInput): Promise<SlackApiResult<unknown>> {
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    input.log("DEBUG", "external_notification.delivery.attempt", { attempt });
    let result: SlackApiResult<unknown>;
    try {
      result = await postSlackMessage(input.api, input.botToken, {
        channel: input.channelId,
        threadTs: input.threadTs,
        ...input.message,
      });
    } catch {
      result = { ok: false, error: "network_error" };
    }

    if (result.ok) {
      input.log("INFO", "external_notification.delivery.delivered", { attempt });
      return result;
    }

    const retryable = isRetryableSlackFailure(result);
    if (!retryable || attempt === MAX_DELIVERY_ATTEMPTS) {
      input.log("ERROR", "external_notification.delivery.exhausted", {
        attempt,
        error: result.error,
        retryable,
        ...(result.status !== undefined ? { http_status: result.status } : {}),
        ...(result.retryAfterMs !== undefined ? { retry_after_ms: result.retryAfterMs } : {}),
      });
      return result;
    }

    const delayMs = retryDelayMs(result, attempt, input.random);
    input.log("WARN", "external_notification.delivery.retrying", {
      attempt,
      next_attempt: attempt + 1,
      error: result.error,
      delay_ms: delayMs,
      ...(result.status !== undefined ? { http_status: result.status } : {}),
      ...(result.retryAfterMs !== undefined ? { retry_after_ms: result.retryAfterMs } : {}),
    });
    await input.sleep(delayMs);
  }
  return { ok: false, error: "retry_exhausted" };
}

function isRetryableSlackFailure(result: Extract<SlackApiResult<unknown>, { ok: false }>): boolean {
  if (result.status === 429 || (result.status !== undefined && result.status >= 500)) return true;
  return ["rate_limited", "ratelimited", "request_timeout", "network_error"].includes(result.error)
    || /^http_5\d\d$/.test(result.error);
}

function retryDelayMs(
  result: Extract<SlackApiResult<unknown>, { ok: false }>,
  attempt: number,
  random: () => number,
): number {
  if (result.retryAfterMs !== undefined) return Math.min(result.retryAfterMs, MAX_RETRY_DELAY_MS);
  const exponential = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(random() * RETRY_JITTER_MS);
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function firstDestination(
  db: D1Database,
  sessionId: string,
): Promise<ExternalConversationDestination | null> {
  const select = externalConversationDestinationBySessionSelect(sessionId);
  return db.prepare(select.sql).bind(...select.bindings).first<ExternalConversationDestination>();
}
