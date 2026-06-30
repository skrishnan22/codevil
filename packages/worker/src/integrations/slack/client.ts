export type SlackApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type SlackApi = <T = Record<string, unknown>>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
) => Promise<SlackApiResult<T> | { ok: false; error: string; data: Record<string, unknown> }>;

export async function slackApi<T>(
  botToken: string | undefined,
  method: string,
  body?: Record<string, unknown>,
): Promise<SlackApiResult<T>> {
  if (!botToken) return { ok: false, error: "missing_bot_token" };

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

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
  ): Promise<SlackApiResult<T> | { ok: false; error: string; data: Record<string, unknown> }> {
    const response = await fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json<Record<string, unknown>>();
    if (!response.ok) return { ok: false, error: slackError(data) ?? `http_${response.status}`, data };
    if (!isSlackOk(data)) return { ok: false, error: slackError(data) ?? "slack_not_ok", data };
    return { ok: true, data: data as T };
  };
}

export function postSlackMessage(
  slackApi: SlackApi,
  botToken: string,
  channel: string,
  text: string,
  options?: { threadTs?: string },
): Promise<SlackApiResult<unknown>>;
export function postSlackMessage(
  botToken: string | undefined,
  channel: string,
  text: string,
  options?: { threadTs?: string },
): Promise<SlackApiResult<unknown>>;
export async function postSlackMessage(
  first: SlackApi | string | undefined,
  second: string,
  third: string,
  fourth: string | { threadTs?: string } = {},
  fifth: { threadTs?: string } = {},
): Promise<SlackApiResult<unknown>> {
  if (typeof first === "function") {
    const options = fifth;
    return first(second, "chat.postMessage", {
      channel: third,
      text: typeof fourth === "string" ? fourth : "",
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    }) as Promise<SlackApiResult<unknown>>;
  }

  const options = typeof fourth === "object" ? fourth : {};
  return slackApi(first, "chat.postMessage", {
    channel: second,
    text: third,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
  });
}

function isSlackOk(data: unknown): data is { ok: true } {
  return typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;
}

function slackError(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}
