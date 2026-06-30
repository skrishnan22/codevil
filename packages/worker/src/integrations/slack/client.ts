export type SlackApiBody = Record<string, unknown>;

export type SlackApiResult<T extends SlackApiBody = SlackApiBody> =
  | { ok: true; data: T }
  | { ok: false; error: string; data?: SlackApiBody };

export type SlackApi = <T extends SlackApiBody = SlackApiBody>(
  token: string,
  method: string,
  body?: SlackApiBody,
) => Promise<SlackApiResult<T>>;

export function createSlackWebApi(fetcher: typeof fetch = fetch): SlackApi {
  return async function slackApi<T extends SlackApiBody = SlackApiBody>(
    token: string,
    method: string,
    body: SlackApiBody = {},
  ): Promise<SlackApiResult<T>> {
    let response: Response;
    try {
      response = await fetcher(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    let data: SlackApiBody;
    try {
      data = await response.json<SlackApiBody>();
    } catch {
      return { ok: false, error: `Slack API returned non-JSON response (${response.status})` };
    }

    if (!response.ok) {
      return { ok: false, error: `Slack API HTTP ${response.status}`, data };
    }

    if (data.ok !== true) {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : "Slack API request failed",
        data,
      };
    }

    return { ok: true, data: data as T };
  };
}

export function postSlackMessage(
  slackApi: SlackApi,
  token: string,
  channel: string,
  text: string,
): Promise<SlackApiResult> {
  return slackApi(token, "chat.postMessage", { channel, text });
}
