import type { Config } from "@codevil/shared";

import type { RunCommand } from "./args.js";

export interface CreateSessionResponse {
  session_id: string;
  ws_url: string;
}

export interface SessionPayload {
  prompt: string;
  repo: string;
  provider: string;
  plan_model: string;
  exec_model: string;
  max_session_time: string;
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<Response>;

export function buildSessionPayload(command: RunCommand, config: Config): SessionPayload {
  return {
    prompt: command.prompt,
    repo: command.repo,
    provider: command.provider ?? config.defaults.provider,
    plan_model: command.planModel ?? config.defaults.plan_model,
    exec_model: command.execModel ?? config.defaults.exec_model,
    max_session_time: command.maxTime ?? config.defaults.max_time,
  };
}

export async function createSession(
  config: Config,
  command: RunCommand,
  fetcher: FetchLike = fetch,
): Promise<CreateSessionResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSessionPayload(command, config)),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json() as Record<string, unknown>;
      detail = String(errBody.detail ?? errBody.error ?? "");
    } catch {
      detail = await response.text();
    }
    throw new Error(`Failed to create session: ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  const body = await response.json() as unknown;
  if (!isRecord(body) || typeof body.session_id !== "string" || typeof body.ws_url !== "string") {
    throw new Error("Invalid create session response");
  }

  return {
    session_id: body.session_id,
    ws_url: body.ws_url,
  };
}

export function buildWebSocketUrl(url: string, cursor: number): string {
  const wsUrl = new URL(url);

  if (wsUrl.protocol === "https:") wsUrl.protocol = "wss:";
  if (wsUrl.protocol === "http:") wsUrl.protocol = "ws:";

  wsUrl.searchParams.set("cursor", cursor.toString());
  return wsUrl.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
