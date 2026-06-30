import { json } from "../../http-handlers.js";
import type { Env } from "../../worker-env.js";
import { createSlackWebApi, type SlackApi } from "./client.js";
import { buildSlackManifest } from "./manifest.js";

export interface SlackStatusDeps {
  slackApi?: SlackApi;
}

export async function handleSlackManifest(request: Request): Promise<Response> {
  const manifest = buildSlackManifest(new URL(request.url).origin);
  return new Response(manifest, {
    status: 200,
    headers: {
      "content-type": "text/yaml; charset=utf-8",
    },
  });
}

export async function handleSlackStatus(env: Env, deps: SlackStatusDeps = {}): Promise<Response> {
  const missing = slackMissingEnv(env);
  const body: Record<string, unknown> = {
    configured: missing.length === 0,
    env: {
      botToken: Boolean(env.SLACK_BOT_TOKEN),
      signingSecret: Boolean(env.SLACK_SIGNING_SECRET),
      botUserId: Boolean(env.CODEVIL_SLACK_BOT_USER_ID),
    },
    missing,
  };

  if (env.SLACK_BOT_TOKEN) {
    const slackApi = deps.slackApi ?? createSlackWebApi();
    const authTest = await slackApi(env.SLACK_BOT_TOKEN, "auth.test");
    body.authTest = authTest.ok
      ? {
          ok: true,
          team: authTest.data.team,
          team_id: authTest.data.team_id,
          user_id: authTest.data.user_id,
        }
      : {
          ok: false,
          error: authTest.error,
        };
  }

  return json(body, 200);
}

function slackMissingEnv(env: Env): string[] {
  const missing: string[] = [];
  if (!env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!env.SLACK_SIGNING_SECRET) missing.push("SLACK_SIGNING_SECRET");
  return missing;
}
