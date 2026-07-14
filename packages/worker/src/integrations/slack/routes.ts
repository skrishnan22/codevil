import { json } from "../../http-handlers.js";
import { workerLog } from "../../logging.js";
import { createSession, type CreateSessionResult } from "../../session-service.js";
import type { Env } from "../../worker-env.js";
import { extractGithubRepoUrl, resolveRepoForExternalRequest } from "../repo-resolution.js";
import {
  channelByExternalIdSelect,
  clearChannelDefaultRepoUpdate,
  dedupeEventInsert,
  externalActorRowId,
  externalParticipantId,
  externalSessionLinkHandledUpdate,
  externalMessageDedupeDelete,
  externalSessionLinkId,
  externalSessionLinkInsert,
  externalSessionLinkSelect,
  integrationChannelRowId,
  integrationId,
  upsertExternalActor,
  upsertChannelDefaultRepo,
  upsertIntegration,
} from "../store.js";
import type { ExternalSessionLinkRow, IntegrationChannelRow } from "../types.js";
import {
  containsBotMention,
  parseCodevilSlashCommand,
  SlackEventCallbackSchema,
  SlackUrlVerificationSchema,
  slackThreadRootTs,
  stripBotMention,
} from "./parser.js";
import { verifySlackSignature } from "./signature.js";
import {
  createSlackWebApi,
  fetchSlackThreadReplies,
  postSlackMessage,
  type SlackApi,
} from "./client.js";
import { formatSlackAgentRequest } from "./context.js";
import { buildSlackManifest } from "./manifest.js";
import {
  isSlackQuestionSelectionAction,
  parseSlackQuestionAction,
  type SlackQuestionAction,
} from "./actions.js";

export interface SlackStatusDeps {
  slackApi?: SlackApi;
}

export interface SlackEventDeps {
  slackApi?: SlackApi;
  createSession?: (
    env: Env,
    requestUrlOrOrigin: string,
    input: { repo: string },
    createdBy: { id: string; name: string; email?: string | null },
  ) => Promise<CreateSessionResult>;
}

export interface SlackActionDeps {
  slackApi?: SlackApi;
  waitUntil?: (promise: Promise<unknown>) => void;
  processAction?: (
    action: SlackQuestionAction,
    env: Env,
    deps: SlackActionDeps,
  ) => Promise<void>;
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

export async function handleSlackEvent(
  request: Request,
  env: Env,
  deps: SlackEventDeps = {},
): Promise<Response> {
  const body = await request.text();
  const valid = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET,
    signature: request.headers.get("x-slack-signature") ?? undefined,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? undefined,
    body,
  });
  if (!valid) return json({ error: "Invalid signature" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const urlVerification = SlackUrlVerificationSchema.safeParse(payload);
  if (urlVerification.success) {
    return plainText(urlVerification.data.challenge);
  }

  const eventCallback = SlackEventCallbackSchema.safeParse(payload);
  if (!eventCallback.success || eventCallback.data.event.type !== "app_mention") {
    return json({ ok: true }, 200);
  }

  const { event } = eventCallback.data;
  const teamId = eventCallback.data.team_id;
  const channelId = event.channel;
  const userId = event.user;
  const messageTs = event.ts;
  const botUserId = env.CODEVIL_SLACK_BOT_USER_ID;

  if (!teamId || !channelId || !userId || !messageTs) return json({ ok: true }, 200);
  if (!botUserId) return json({ ok: true }, 200);
  if (event.bot_id || (botUserId && userId === botUserId)) return json({ ok: true }, 200);
  if (!containsBotMention(event.text, botUserId)) return json({ ok: true }, 200);

  const integrationIdValue = integrationId("slack", teamId);
  const externalEventId = eventCallback.data.event_id ?? `${channelId}:${messageTs}`;
  const handledAt = new Date().toISOString();
  const dedupe = dedupeEventInsert(
    externalEventId,
    integrationIdValue,
    messageTs,
    handledAt,
  );
  const dedupeResult = await env.DB.prepare(dedupe.sql).bind(...dedupe.bindings).run();
  if (d1Changes(dedupeResult) === 0) return json({ ok: true }, 200);

  await runStatement(env.DB, upsertIntegration({
    id: integrationIdValue,
    provider: "slack",
    external_workspace_id: teamId,
    external_workspace_name: null,
    bot_external_actor_id: botUserId ?? null,
    config_json: "{}",
    created_at: handledAt,
    updated_at: handledAt,
  }));

  await runStatement(env.DB, upsertExternalActor({
    id: externalActorRowId(integrationIdValue, userId),
    integration_id: integrationIdValue,
    external_actor_id: userId,
    display_name: userId,
    email: null,
    linked_auth_user_id: null,
    metadata_json: "{}",
    created_at: handledAt,
    updated_at: handledAt,
  }));

  const actor = { id: externalParticipantId("slack", userId), name: userId };
  const strippedText = stripBotMention(event.text ?? "", botUserId);
  const rootConversationId = slackThreadRootTs({ ts: messageTs, thread_ts: event.thread_ts });
  const channelRow = await firstRow<Pick<IntegrationChannelRow, "default_repo_url"> | null>(
    env.DB,
    channelByExternalIdSelect(integrationIdValue, channelId),
  );
  const existingLink = await firstRow<ExternalSessionLinkRow | null>(
    env.DB,
    externalSessionLinkSelect(integrationIdValue, channelId, rootConversationId),
  );
  if (!env.SLACK_BOT_TOKEN) return json({ ok: true }, 200);
  const slackApi = deps.slackApi ?? createSlackWebApi();
  const thread = await fetchSlackThreadReplies(
    slackApi,
    env.SLACK_BOT_TOKEN,
    channelId,
    rootConversationId,
  );
  if (!thread.ok) {
    workerLog("WARN", "slack.thread.read.failed", {
      error: thread.error,
      channel_id: channelId,
      thread_ts: rootConversationId,
    });
    await postSlackReply(
      env,
      deps,
      channelId,
      "I couldn't read this Slack thread. Please try tagging me again.",
      rootConversationId,
    );
    return json({ ok: true }, 200);
  }
  const threadMessages = thread.data.messages.some((message) => message.ts === messageTs)
    ? thread.data.messages
    : [...thread.data.messages, { ts: messageTs, user: userId, text: event.text }];
  const agentRequestText = formatSlackAgentRequest({
    messages: threadMessages,
    requesterId: userId,
    explicitRequestTs: messageTs,
    lastHandledMessageId: existingLink?.last_handled_message_id,
    botUserId,
  });
  const repo = resolveRepoForExternalRequest({
    text: strippedText,
    contextText: threadMessages.map((message) => message.text ?? "").join("\n"),
    channelDefaultRepoUrl: channelRow?.default_repo_url ?? null,
  });

  if (!existingLink && !repo) {
    await postSlackReply(
      env,
      deps,
      channelId,
      "Please include a GitHub repo URL or use /codevil set-repo first.",
      rootConversationId,
    );
    return json({ ok: true }, 200);
  }

  let sessionId = existingLink?.session_id;
  if (!sessionId) {
    try {
      const created = await (deps.createSession ?? createSession)(env, request.url, { repo: repo!.repoUrl }, actor);
      sessionId = created.session_id;
      await runStatement(env.DB, externalSessionLinkInsert({
        id: externalSessionLinkId(integrationIdValue, channelId, rootConversationId),
        integration_id: integrationIdValue,
        external_channel_id: channelId,
        external_conversation_id: rootConversationId,
        session_id: sessionId,
        last_handled_message_id: messageTs,
        created_by_external_actor_id: userId,
        created_at: handledAt,
        updated_at: handledAt,
      }));
    } catch {
      await releaseDedupe(env.DB, integrationIdValue, externalEventId);
      await postSlackReply(
        env,
        deps,
        channelId,
        "I couldn't start Codevil right now. Please try again.",
        rootConversationId,
      );
      return json({ ok: true }, 200);
    }
  }

  let submit;
  try {
    submit = await env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(sessionId)).submitAgentRequest({
      text: agentRequestText,
      actor,
      planFirst: false,
    });
  } catch {
    await releaseDedupe(env.DB, integrationIdValue, externalEventId);
    await postSlackReply(
      env,
      deps,
      channelId,
      "I couldn't hand that off to Codevil right now. Please try again.",
      rootConversationId,
    );
    return json({ ok: true }, 200);
  }

  if (!submit.ok) {
    await releaseDedupe(env.DB, integrationIdValue, externalEventId);
    await postSlackReply(
      env,
      deps,
      channelId,
      "I couldn't hand that off to Codevil right now. Please try again.",
      rootConversationId,
    );
    return json({ ok: true }, 200);
  }

  if (existingLink) {
    await runStatement(env.DB, externalSessionLinkHandledUpdate(existingLink.id, messageTs, handledAt));
  }

  return json({ ok: true }, 200);
}

export async function handleSlackAction(
  request: Request,
  env: Env,
  deps: SlackActionDeps = {},
): Promise<Response> {
  const body = await request.text();
  const valid = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET,
    signature: request.headers.get("x-slack-signature") ?? undefined,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? undefined,
    body,
  });
  if (!valid) return json({ error: "Invalid signature" }, 401);

  const encodedPayload = new URLSearchParams(body).get("payload");
  if (!encodedPayload) return json({ error: "Missing Slack action payload" }, 400);

  let payload: unknown;
  try {
    payload = JSON.parse(encodedPayload);
  } catch {
    return json({ error: "Invalid Slack action payload" }, 400);
  }

  if (isSlackQuestionSelectionAction(payload)) return json({ ok: true }, 200);
  const action = parseSlackQuestionAction(payload);
  if (!action) return json({ error: "Unsupported Slack action" }, 400);

  const process = deps.processAction ?? (async () => {});
  const processing = process(action, env, deps);
  if (deps.waitUntil) deps.waitUntil(processing);
  else await processing;
  return json({ ok: true }, 200);
}

function slackMissingEnv(env: Env): string[] {
  const missing: string[] = [];
  if (!env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!env.SLACK_SIGNING_SECRET) missing.push("SLACK_SIGNING_SECRET");
  if (!env.CODEVIL_SLACK_BOT_USER_ID) missing.push("CODEVIL_SLACK_BOT_USER_ID");
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

async function releaseDedupe(
  db: D1Database,
  integrationIdValue: string,
  externalEventId: string,
): Promise<void> {
  await runStatement(db, externalMessageDedupeDelete(integrationIdValue, externalEventId));
}

async function firstRow<T>(
  db: D1Database,
  statement: { sql: string; bindings: unknown[] },
): Promise<T | null> {
  return await db.prepare(statement.sql).bind(...statement.bindings).first<T>();
}

async function postSlackReply(
  env: Env,
  deps: SlackEventDeps,
  channelId: string,
  text: string,
  threadTs: string,
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;
  const slackApi = deps.slackApi ?? createSlackWebApi();
  await postSlackMessage(slackApi, env.SLACK_BOT_TOKEN, {
    channel: channelId,
    text,
    threadTs,
  });
}

function d1Changes(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0);
}
