import type { DOToCLIEvent } from "@codevil/shared";
import { workerLogForSession, workerLogSessionExceptionForEnv } from "../logging.js";
import { collectWorkerSecretValues, type WorkerSecretEnv } from "../worker-env.js";
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
import { externalSessionUrl } from "./session-url.js";

export interface ExternalNotificationDeps {
  slackApi?: SlackApi;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface ExternalNotificationEnv extends WorkerSecretEnv {
  DB: D1Database;
  SLACK_BOT_TOKEN?: string;
  CODEVIL_WEB_ORIGIN?: string;
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
): Promise<boolean> {
  const intent = externalNotificationIntent(input.event);
  if (!intent) return true;

  const secrets = collectWorkerSecretValues(input.env);
  const log = (
    severity: "DEBUG" | "INFO" | "WARN" | "ERROR",
    event: string,
    attributes: Record<string, unknown> = {},
  ): void => {
    workerLogForSession(input.sessionId, severity, event, {
      cursor: input.cursor,
      event_type: input.event.type,
      ...attributes,
    }, secrets);
  };

  log("DEBUG", "external_notification.mapped", { intent_type: intent.type });

  try {
    const destination = await firstDestination(input.env.DB, input.sessionId);
    if (!destination) {
      log("DEBUG", "external_notification.skipped", { reason: "no_destination" });
      return true;
    }
    if (destination.provider !== "slack") {
      log("DEBUG", "external_notification.skipped", {
        reason: "unsupported_provider",
        provider: destination.provider,
      });
      return true;
    }
    if (!input.env.SLACK_BOT_TOKEN) {
      log("WARN", "external_notification.skipped", {
        reason: "missing_slack_bot_token",
        provider: destination.provider,
        channel_id: destination.external_channel_id,
        thread_ts: destination.external_conversation_id,
      });
      return false;
    }

    const api = deps.slackApi ?? createSlackWebApi();
    const sleep = deps.sleep ?? sleepFor;
    const random = deps.random ?? Math.random;
    const sessionUrl = externalSessionUrl(input.env, input.workerOrigin, input.sessionId);
    const messages = renderSlackNotification(intent, sessionUrl);
    const baseExternalEventId = `outbound:${input.sessionId}:${input.cursor}`;
    for (const [messageIndex, message] of messages.entries()) {
      const externalEventId = messages.length === 1
        ? baseExternalEventId
        : `${baseExternalEventId}:chunk:${messageIndex}`;
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
      if (Number(claim.meta.changes ?? 0) === 0) {
        log("DEBUG", "external_notification.skipped", {
          reason: "duplicate",
          provider: destination.provider,
          external_event_id: externalEventId,
          message_index: messageIndex,
          message_count: messages.length,
        });
        continue;
      }

      log("INFO", "external_notification.claimed", {
        provider: destination.provider,
        intent_type: intent.type,
        external_event_id: externalEventId,
        channel_id: destination.external_channel_id,
        thread_ts: destination.external_conversation_id,
        message_index: messageIndex,
        message_count: messages.length,
      });

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
        }, collectWorkerSecretValues(input.env)),
      });
      if (!result.ok) {
        const release = externalMessageDedupeDelete(destination.integration_id, externalEventId);
        await input.env.DB.prepare(release.sql).bind(...release.bindings).run();
        return false;
      }
    }
    return true;
  } catch (error) {
    workerLogSessionExceptionForEnv(input.sessionId, "external_notification.delivery.failed", error, input.env, {
      cursor: input.cursor,
      event_type: input.event.type,
    });
    return false;
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
