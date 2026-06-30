import { json } from "../../http-handlers.js";
import type { Env } from "../../worker-env.js";
import { extractGithubRepoUrl } from "../repo-resolution.js";
import {
  channelByExternalIdSelect,
  clearChannelDefaultRepoUpdate,
  integrationChannelRowId,
  integrationId,
  upsertChannelDefaultRepo,
  upsertIntegration,
} from "../store.js";
import type { IntegrationChannelRow } from "../types.js";
import { parseCodevilSlashCommand } from "./parser.js";
import { verifySlackSignature } from "./signature.js";
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

const HELP_TEXT = `Usage:
/codevil set-repo https://github.com/org/repo
/codevil repo
/codevil clear-repo`;

export async function handleSlackCommand(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const valid = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET,
    signature: request.headers.get("x-slack-signature") ?? undefined,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? undefined,
    body,
  });
  if (!valid) return json({ error: "Invalid signature" }, 401);

  const form = new URLSearchParams(body);
  const teamId = form.get("team_id") ?? "";
  const teamDomain = form.get("team_domain") || null;
  const channelId = form.get("channel_id") ?? "";
  const channelName = form.get("channel_name") || null;
  const text = form.get("text") ?? "";

  if (!teamId || !channelId) {
    return json({ error: "Missing Slack team or channel" }, 400);
  }

  const integrationIdValue = integrationId("slack", teamId);
  const now = new Date().toISOString();
  await runStatement(env.DB, upsertIntegration({
    id: integrationIdValue,
    provider: "slack",
    external_workspace_id: teamId,
    external_workspace_name: teamDomain,
    bot_external_actor_id: env.CODEVIL_SLACK_BOT_USER_ID ?? null,
    config_json: "{}",
    created_at: now,
    updated_at: now,
  }));

  const command = parseCodevilSlashCommand(text);
  if (command.type === "set_repo") {
    const repo = extractGithubRepoUrl(command.repoUrl);
    if (!repo) return plainText(HELP_TEXT);

    await runStatement(env.DB, upsertChannelDefaultRepo({
      id: integrationChannelRowId(integrationIdValue, channelId),
      integration_id: integrationIdValue,
      external_channel_id: channelId,
      display_name: channelName,
      default_repo_url: repo.repoUrl,
      metadata_json: "{}",
      created_at: now,
      updated_at: now,
    }));

    return plainText(`Set Codevil default repo for this channel to ${repo.repoUrl}.`);
  }

  if (command.type === "repo") {
    const select = channelByExternalIdSelect(integrationIdValue, channelId);
    const row = await env.DB
      .prepare(select.sql)
      .bind(...select.bindings)
      .first<Pick<IntegrationChannelRow, "default_repo_url">>();
    if (row?.default_repo_url) {
      return plainText(`This channel default repo is ${row.default_repo_url}.`);
    }
    return plainText("This channel does not have a Codevil default repo.");
  }

  if (command.type === "clear_repo") {
    await runStatement(env.DB, clearChannelDefaultRepoUpdate(integrationIdValue, channelId, now));
    return plainText("Cleared the Codevil default repo for this channel.");
  }

  return plainText(HELP_TEXT);
}

function plainText(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

async function runStatement(db: D1Database, statement: { sql: string; bindings: unknown[] }): Promise<void> {
  await db.prepare(statement.sql).bind(...statement.bindings).run();
}
