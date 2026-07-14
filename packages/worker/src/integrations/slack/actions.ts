import { z } from "zod";

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

const QuestionActionValueSchema = z.object({
  v: z.literal(1),
  q: z.string().min(1),
  i: z.number().int().nonnegative().optional(),
});

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

export function parseSlackQuestionAction(payload: unknown): SlackQuestionAction | null {
  const parsed = SlackBlockActionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const action = parsed.data.actions[0];
  if (action.action_id !== "codevil_question_answer" && action.action_id !== "codevil_question_submit") {
    return null;
  }
  const value = parseQuestionActionValue(action.value);
  if (!value) return null;

  const optionIndexes = action.action_id === "codevil_question_answer"
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

export function isSlackQuestionSelectionAction(payload: unknown): boolean {
  const parsed = SlackBlockActionSchema.safeParse(payload);
  return parsed.success && parsed.data.actions[0]?.action_id === "codevil_question_select";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
