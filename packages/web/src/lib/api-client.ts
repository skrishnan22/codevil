import type {
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
} from "@codevil/shared";
import type { SessionConfig, NewSessionParams } from "../types";

type FetchFn = typeof globalThis.fetch;

export async function createSession(
  config: SessionConfig,
  params: NewSessionParams,
  fetcher: FetchFn = globalThis.fetch,
): Promise<CreateSessionResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");

  const response = await fetcher(`${endpoint}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: params.repo,
      provider: params.provider,
      plan_model: params.planModel,
      exec_model: params.execModel,
      max_cost: params.maxCost,
      max_session_time: params.maxSessionTime,
      max_idle_time: params.maxIdleTime,
      max_steps: params.maxSteps,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as Record<string, unknown>;
      detail = String(body.detail ?? body.error ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to create session: ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  const body = (await response.json()) as CreateSessionResponse;
  return { session_id: body.session_id, ws_url: body.ws_url, summary: body.summary };
}

export async function listSessions(
  config: SessionConfig,
  fetcher: FetchFn = globalThis.fetch,
): Promise<ListSessionsResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/sessions`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  } as RequestInit);

  if (!response.ok) {
    throw new Error(`Failed to list sessions: ${response.status}`);
  }

  return (await response.json()) as ListSessionsResponse;
}

export async function getSession(
  config: SessionConfig,
  sessionId: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<GetSessionResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/sessions/${sessionId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  } as RequestInit);

  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.status}`);
  }

  return (await response.json()) as GetSessionResponse;
}
