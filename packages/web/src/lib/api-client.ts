import type { SessionConfig, NewSessionParams } from "../types";

export interface CreateSessionResponse {
  session_id: string;
  ws_url: string;
}

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
      prompt: params.prompt,
      repo: params.repo,
      provider: params.provider,
      plan_model: params.planModel,
      exec_model: params.execModel,
      max_cost: params.maxCost,
      max_time: params.maxTime,
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
  return { session_id: body.session_id, ws_url: body.ws_url };
}
