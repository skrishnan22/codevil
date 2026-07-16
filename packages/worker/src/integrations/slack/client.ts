export type SlackApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; retryAfterMs?: number; data?: unknown };
export type SlackApi = <T = Record<string, unknown>>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
) => Promise<SlackApiResult<T>>;

export type SlackBlock = Record<string, unknown> & { type: string };

export interface SlackMessageContent {
  text: string;
  blocks?: SlackBlock[];
}

export async function slackApi<T>(
  botToken: string | undefined,
  method: string,
  body?: Record<string, unknown>,
): Promise<SlackApiResult<T>> {
  if (!botToken) return { ok: false, error: "missing_bot_token" };

  const response = await fetch(`https://slack.com/api/${method}`, slackRequestInit(botToken, method, body));

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Slack normally returns JSON; fall through to HTTP status when it does not.
  }

  if (!response.ok) {
    return { ok: false, error: slackError(data) ?? `http_${response.status}` };
  }

  if (!isSlackOk(data)) {
    return { ok: false, error: slackError(data) ?? "slack_not_ok" };
  }

  return { ok: true, data: data as T };
}

export function createSlackWebApi(fetcher: typeof fetch = fetch): SlackApi {
  return async function slackWebApi<T>(
    botToken: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<SlackApiResult<T>> {
    let response: Response;
    try {
      response = await fetcher(`https://slack.com/api/${method}`, slackRequestInit(botToken, method, body));
    } catch {
      return { ok: false, error: "network_error" };
    }
    let data: unknown = null;
    try {
      data = await response.json<Record<string, unknown>>();
    } catch {
      // Slack may return a non-JSON gateway or rate-limit response.
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      return {
        ok: false,
        error: slackError(data) ?? `http_${response.status}`,
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        data,
      };
    }
    if (!isSlackOk(data)) return { ok: false, error: slackError(data) ?? "slack_not_ok", data };
    return { ok: true, data: data as T };
  };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}

export interface SlackMessageInput extends SlackMessageContent {
  channel: string;
  threadTs?: string;
}

export interface SlackPostedMessage {
  ok: true;
  ts: string;
  channel?: string;
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
  is_bot?: boolean;
  is_app_user?: boolean;
}

export interface SlackThreadMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

export function fetchSlackThreadReplies(
  api: SlackApi,
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<SlackApiResult<{ messages: SlackThreadMessage[] }>> {
  return api(botToken, "conversations.replies", {
    channel,
    ts: threadTs,
    limit: 100,
  }) as Promise<SlackApiResult<{ messages: SlackThreadMessage[] }>>;
}

export function postSlackMessage(
  api: SlackApi,
  botToken: string,
  input: SlackMessageInput,
): Promise<SlackApiResult<SlackPostedMessage>> {
  return api(botToken, "chat.postMessage", {
    channel: input.channel,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  }) as Promise<SlackApiResult<SlackPostedMessage>>;
}

export function updateSlackMessage(
  api: SlackApi,
  botToken: string,
  input: SlackMessageContent & { channel: string; ts: string },
): Promise<SlackApiResult<unknown>> {
  return api(botToken, "chat.update", {
    channel: input.channel,
    ts: input.ts,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
  }) as Promise<SlackApiResult<unknown>>;
}

export function postSlackEphemeral(
  api: SlackApi,
  botToken: string,
  input: { channel: string; user: string; text: string },
): Promise<SlackApiResult<unknown>> {
  return api(botToken, "chat.postEphemeral", input) as Promise<SlackApiResult<unknown>>;
}

export function fetchSlackUser(
  api: SlackApi,
  botToken: string,
  user: string,
): Promise<SlackApiResult<{ ok: true; user: SlackUser }>> {
  return api(botToken, "users.info", { user }) as Promise<SlackApiResult<{ ok: true; user: SlackUser }>>;
}

function isSlackOk(data: unknown): data is { ok: true } {
  return typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;
}

function slackRequestInit(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): RequestInit {
  const values = body ?? {};
  const formEncoded = method === "conversations.replies";
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": formEncoded
        ? "application/x-www-form-urlencoded; charset=utf-8"
        : "application/json",
    },
    body: formEncoded
      ? new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)] as [string, string])).toString()
      : JSON.stringify(values),
  };
}

function slackError(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}
