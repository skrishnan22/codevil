import { z } from "zod";
import { isRecord } from "@codevil/shared";
import { workerLogForSession } from "../../logging.js";
import { collectWorkerSecretValues, type Env } from "../../worker-env.js";
import {
  externalActorRowId,
  externalParticipantId,
  externalSessionLinkSelect,
  integrationId,
  upsertExternalActor,
} from "../store.js";
import type { ExternalSessionLinkRow } from "../types.js";
import {
  createSlackWebApi,
  fetchSlackUser,
  postSlackEphemeral,
  slackUserDisplayName,
  updateSlackMessage,
  type SlackApi,
} from "./client.js";
import { renderAnsweredSlackQuestion, renderSlackFreeformAnswerModal } from "./render.js";

const SlackBlockActionSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  container: z.object({ message_ts: z.string().min(1) }),
  message: z.object({
    ts: z.string().min(1),
    thread_ts: z.string().min(1).optional(),
  }),
  actions: z.array(z.object({
    action_id: z.string().min(1),
    action_ts: z.string().min(1),
    value: z.string().optional(),
  }).passthrough()).min(1),
  state: z.unknown().optional(),
});

const SlackFreeformOpenActionSchema = SlackBlockActionSchema.extend({
  trigger_id: z.string().min(1),
});

const SlackFreeformSubmissionSchema = z.object({
  type: z.literal("view_submission"),
  trigger_id: z.string().min(1),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  view: z.object({
    callback_id: z.string().min(1),
    private_metadata: z.string().min(1),
    state: z.object({
      values: z.record(z.string(), z.record(z.string(), z.object({
        value: z.string().nullable().optional(),
      }).passthrough())),
    }),
  }),
});

const QuestionActionValueSchema = z.object({
  v: z.literal(1),
  q: z.string().min(1),
  i: z.number().int().nonnegative().optional(),
});

const SlackFreeformPrivateMetadataSchema = z.object({
  v: z.literal(1),
  q: z.string().min(1),
  t: z.string().min(1),
  c: z.string().min(1),
  th: z.string().min(1),
  m: z.string().min(1),
}).strict();

const MAX_SLACK_PRIVATE_METADATA_LENGTH = 3_000;

type SlackFreeformPrivateMetadata = z.infer<typeof SlackFreeformPrivateMetadataSchema>;

export interface SlackQuestionAction {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requestId: string;
  optionIndexes: number[];
  actionTs: string;
}

export interface SlackFreeformOpenAction {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requestId: string;
  triggerId: string;
}

export interface SlackFreeformSubmission {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requestId: string;
  freeform: string;
}

export interface SlackFreeformPrivateMetadataInput {
  requestId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

export interface SlackActionProcessDeps {
  slackApi?: SlackApi;
  workerOrigin?: string;
}

export function encodeSlackFreeformPrivateMetadata(
  input: SlackFreeformPrivateMetadataInput,
): string | null {
  const value = JSON.stringify({
    v: 1,
    q: input.requestId,
    t: input.teamId,
    c: input.channelId,
    th: input.threadTs,
    m: input.messageTs,
  });
  return value.length < MAX_SLACK_PRIVATE_METADATA_LENGTH ? value : null;
}

export function parseSlackFreeformPrivateMetadata(value: unknown): SlackFreeformPrivateMetadata | null {
  if (typeof value !== "string" || value.length >= MAX_SLACK_PRIVATE_METADATA_LENGTH) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = SlackFreeformPrivateMetadataSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

export function parseSlackFreeformOpenAction(payload: unknown): SlackFreeformOpenAction | null {
  const parsed = SlackFreeformOpenActionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const action = parsed.data.actions[0];
  if (action.action_id !== "codevil_question_open_freeform") return null;
  const value = parseQuestionActionValue(action.value);
  if (!value || value.i !== undefined) return null;
  return {
    teamId: parsed.data.team.id,
    userId: parsed.data.user.id,
    channelId: parsed.data.channel.id,
    messageTs: parsed.data.message.ts,
    threadTs: parsed.data.message.thread_ts ?? parsed.data.message.ts,
    requestId: value.q,
    triggerId: parsed.data.trigger_id,
  };
}

export function parseSlackFreeformSubmission(payload: unknown): SlackFreeformSubmission | null {
  const parsed = SlackFreeformSubmissionSchema.safeParse(payload);
  if (!parsed.success || parsed.data.view.callback_id !== "codevil_question_freeform") return null;
  const metadata = parseSlackFreeformPrivateMetadata(parsed.data.view.private_metadata);
  if (!metadata || parsed.data.team.id !== metadata.t) return null;

  const input = parsed.data.view.state.values.codevil_question_freeform_input
    ?.codevil_question_freeform_value?.value;
  if (typeof input !== "string") return null;
  const freeform = input.trim();
  if (freeform.length === 0) return null;

  return {
    teamId: parsed.data.team.id,
    userId: parsed.data.user.id,
    channelId: metadata.c,
    messageTs: metadata.m,
    threadTs: metadata.th,
    requestId: metadata.q,
    freeform,
  };
}

export function parseSlackQuestionAction(payload: unknown): SlackQuestionAction | null {
  const parsed = SlackBlockActionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const action = parsed.data.actions[0];
  // Keep the bare action id for in-flight messages rendered before buttons were indexed.
  const isDirectAnswer = action.action_id === "codevil_question_answer"
    || action.action_id.startsWith("codevil_question_answer_");
  if (!isDirectAnswer && action.action_id !== "codevil_question_submit") {
    return null;
  }
  const value = parseQuestionActionValue(action.value);
  if (!value) return null;

  const optionIndexes = isDirectAnswer
    ? value.i === undefined ? [] : [value.i]
    : selectedOptionIndexes(parsed.data.state);
  if (optionIndexes.length === 0) return null;

  return {
    teamId: parsed.data.team.id,
    userId: parsed.data.user.id,
    channelId: parsed.data.channel.id,
    messageTs: parsed.data.message.ts || parsed.data.container.message_ts,
    threadTs: parsed.data.message.thread_ts ?? parsed.data.message.ts,
    requestId: value.q,
    optionIndexes,
    actionTs: action.action_ts,
  };
}

export function isSlackNonSubmittingAction(payload: unknown): boolean {
  const parsed = SlackBlockActionSchema.safeParse(payload);
  if (!parsed.success) return false;
  return ["codevil_question_select", "codevil_open_session"].includes(
    parsed.data.actions[0]?.action_id,
  );
}

export async function processSlackQuestionAction(
  action: SlackQuestionAction,
  env: Env,
  deps: SlackActionProcessDeps = {},
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || action.userId === env.CODEVIL_SLACK_BOT_USER_ID) return;
  const api = deps.slackApi ?? createSlackWebApi();
  const integrationIdValue = integrationId("slack", action.teamId);
  const linkStatement = externalSessionLinkSelect(integrationIdValue, action.channelId, action.threadTs);
  const link = await env.DB
    .prepare(linkStatement.sql)
    .bind(...linkStatement.bindings)
    .first<ExternalSessionLinkRow>();
  if (!link) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "This Slack thread is not linked to a Codevil session.");
    return;
  }

  const actor = await resolveSlackHumanActor(action, env, api);
  if (!actor) return;
  let result;
  try {
    result = await env.ORCHESTRATOR
      .get(env.ORCHESTRATOR.idFromName(link.session_id))
      .answerQuestionFromIntegration({
        requestId: action.requestId,
        optionIndexes: action.optionIndexes,
        actor,
      });
  } catch {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "I couldn't submit that answer. Please try again.");
    return;
  }

  if (!result.ok) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, result.error);
    return;
  }

  const answeredByText = slackAnswererText(result.answeredBy);
  const update = await updateSlackMessage(api, env.SLACK_BOT_TOKEN, {
    channel: action.channelId,
    ts: action.messageTs,
    ...renderAnsweredSlackQuestion({
      question: result.question,
      selectedLabels: result.selectedLabels,
      answeredByText,
    }),
  });
  if (!update.ok) {
    workerLogForSession(link.session_id, "WARN", "slack.question.update.failed", {
      error: update.error,
      channel_id: action.channelId,
      message_ts: action.messageTs,
    }, collectWorkerSecretValues(env));
  }
  if (result.status === "already_answered") {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "This question was already answered.");
  }
}

export async function processSlackFreeformOpenAction(
  action: SlackFreeformOpenAction,
  env: Env,
  deps: SlackActionProcessDeps = {},
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || action.userId === env.CODEVIL_SLACK_BOT_USER_ID) return;
  const api = deps.slackApi ?? createSlackWebApi();
  const integrationIdValue = integrationId("slack", action.teamId);
  const linkStatement = externalSessionLinkSelect(integrationIdValue, action.channelId, action.threadTs);
  const link = await env.DB
    .prepare(linkStatement.sql)
    .bind(...linkStatement.bindings)
    .first<ExternalSessionLinkRow>();
  if (!link) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "This Slack thread is not linked to a Codevil session.");
    return;
  }

  let question;
  try {
    question = await env.ORCHESTRATOR
      .get(env.ORCHESTRATOR.idFromName(link.session_id))
      .freeformQuestionForIntegration({ requestId: action.requestId });
  } catch {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "I couldn't open that question. Please try again.");
    return;
  }
  if (!question.ok) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, question.error);
    return;
  }

  const privateMetadata = encodeSlackFreeformPrivateMetadata({
    requestId: action.requestId,
    teamId: action.teamId,
    channelId: action.channelId,
    threadTs: action.threadTs,
    messageTs: action.messageTs,
  });
  if (!privateMetadata) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "I couldn't open that question. Please try again.");
    return;
  }

  try {
    const opened = await api(env.SLACK_BOT_TOKEN, "views.open", {
      trigger_id: action.triggerId,
      view: renderSlackFreeformAnswerModal({
        question: question.question,
        ...(question.context !== undefined ? { context: question.context } : {}),
        privateMetadata,
      }),
    });
    if (opened.ok) return;
    workerLogForSession(link.session_id, "WARN", "slack.question.modal_open.failed", {
      error: opened.error,
      channel_id: action.channelId,
      message_ts: action.messageTs,
    }, collectWorkerSecretValues(env));
  } catch (error) {
    workerLogForSession(link.session_id, "WARN", "slack.question.modal_open.failed", {
      error: error instanceof Error ? error.message : String(error),
      channel_id: action.channelId,
      message_ts: action.messageTs,
    }, collectWorkerSecretValues(env));
  }
  await notifyActionFailure(api, env.SLACK_BOT_TOKEN, action, "I couldn't open that question. Please try again.");
}

export async function processSlackFreeformSubmission(
  submission: SlackFreeformSubmission,
  env: Env,
  deps: SlackActionProcessDeps = {},
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || submission.userId === env.CODEVIL_SLACK_BOT_USER_ID) return;
  const api = deps.slackApi ?? createSlackWebApi();
  const integrationIdValue = integrationId("slack", submission.teamId);
  const linkStatement = externalSessionLinkSelect(integrationIdValue, submission.channelId, submission.threadTs);
  const link = await env.DB
    .prepare(linkStatement.sql)
    .bind(...linkStatement.bindings)
    .first<ExternalSessionLinkRow>();
  if (!link) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, submission, "This Slack thread is not linked to a Codevil session.");
    return;
  }

  const actor = await resolveSlackHumanActor(submission, env, api);
  if (!actor) return;

  let result;
  try {
    result = await env.ORCHESTRATOR
      .get(env.ORCHESTRATOR.idFromName(link.session_id))
      .answerQuestionFromIntegration({
        requestId: submission.requestId,
        freeform: submission.freeform,
        actor,
      });
  } catch {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, submission, "I couldn't submit that answer. Please try again.");
    return;
  }
  if (!result.ok) {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, submission, result.error);
    return;
  }

  try {
    const update = await updateSlackMessage(api, env.SLACK_BOT_TOKEN, {
      channel: submission.channelId,
      ts: submission.messageTs,
      ...renderAnsweredSlackQuestion({
        question: result.question,
        selectedLabels: result.selectedLabels,
        answeredByText: slackAnswererText(result.answeredBy),
      }),
    });
    if (!update.ok) {
      workerLogForSession(link.session_id, "WARN", "slack.question.update.failed", {
        error: update.error,
        channel_id: submission.channelId,
        message_ts: submission.messageTs,
      }, collectWorkerSecretValues(env));
    }
  } catch (error) {
    workerLogForSession(link.session_id, "WARN", "slack.question.update.failed", {
      error: error instanceof Error ? error.message : String(error),
      channel_id: submission.channelId,
      message_ts: submission.messageTs,
    }, collectWorkerSecretValues(env));
  }
  if (result.status === "already_answered") {
    await notifyActionFailure(api, env.SLACK_BOT_TOKEN, submission, "This question was already answered.");
  }
}

async function resolveSlackHumanActor(
  action: Pick<SlackQuestionAction, "teamId" | "userId">,
  env: Env,
  api: SlackApi,
): Promise<{ id: string; name: string } | null> {
  const botToken = env.SLACK_BOT_TOKEN;
  if (!botToken) return null;
  const profile = await fetchSlackUser(api, botToken, action.userId);
  if (profile.ok && profile.data.user && (profile.data.user.is_bot || profile.data.user.is_app_user)) return null;
  const displayName = profile.ok && profile.data.user
    ? slackUserDisplayName(profile.data.user, action.userId)
    : action.userId;
  const integrationIdValue = integrationId("slack", action.teamId);
  const now = new Date().toISOString();
  const actorStatement = upsertExternalActor({
    id: externalActorRowId(integrationIdValue, action.userId),
    integration_id: integrationIdValue,
    external_actor_id: action.userId,
    display_name: displayName,
    email: null,
    linked_auth_user_id: null,
    metadata_json: "{}",
    created_at: now,
    updated_at: now,
  });
  await env.DB.prepare(actorStatement.sql).bind(...actorStatement.bindings).run();
  return { id: externalParticipantId("slack", action.userId), name: displayName };
}

function slackAnswererText(actor: { id: string; name: string }): string {
  const slackId = actor.id.match(/^external:slack:([A-Z0-9]+)$/)?.[1];
  return slackId ? `<@${slackId}>` : escapeSlackText(actor.name);
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function notifyActionFailure(
  api: SlackApi,
  botToken: string,
  action: Pick<SlackQuestionAction, "channelId" | "userId">,
  text: string,
): Promise<void> {
  await postSlackEphemeral(api, botToken, {
    channel: action.channelId,
    user: action.userId,
    text,
  });
}

function parseQuestionActionValue(value: string | undefined): z.infer<typeof QuestionActionValueSchema> | null {
  if (!value) return null;
  try {
    const parsed = QuestionActionValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function selectedOptionIndexes(state: unknown): number[] {
  if (!isRecord(state) || !isRecord(state.values)) return [];
  const selected: number[] = [];
  for (const block of Object.values(state.values)) {
    if (!isRecord(block)) continue;
    const control = block.codevil_question_select;
    if (!isRecord(control)) continue;
    if (isRecord(control.selected_option)) {
      const ordinal = parseOrdinal(control.selected_option.value);
      if (ordinal !== null) selected.push(ordinal);
    }
    if (Array.isArray(control.selected_options)) {
      for (const option of control.selected_options) {
        if (!isRecord(option)) continue;
        const ordinal = parseOrdinal(option.value);
        if (ordinal !== null) selected.push(ordinal);
      }
    }
  }
  return [...new Set(selected)].sort((a, b) => a - b);
}

function parseOrdinal(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
