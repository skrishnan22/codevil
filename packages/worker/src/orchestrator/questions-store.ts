import {
  parseSqliteRow,
  QuestionRowSchema,
  RequestIdRowSchema,
  type QuestionRow,
} from "@codevil/shared";
import { z } from "zod";

export type { QuestionRow };

export function questionAnswerDeniedMessage(question: {
  answerable_by: QuestionRow["answerable_by"];
  assigned_to_name: string | null;
}): string {
  if (question.answerable_by === "assigned") {
    return question.assigned_to_name
      ? `Only ${question.assigned_to_name} can answer this question.`
      : "Only the assigned participant can answer this question.";
  }
  if (question.answerable_by === "anyone") {
    return "Only session participants can answer this question.";
  }
  return "Only the session creator can answer this question.";
}

export function loadQuestionRow(sql: SqlStorage, requestId: string): QuestionRow | null {
  for (const row of sql.exec(
    `SELECT run_id, status, answerable_by, assigned_to_id, assigned_to_name
     FROM questions
     WHERE request_id = ?`,
    requestId,
  )) {
    return parseSqliteRow(
      QuestionRowSchema,
      row,
      "sqlite_question",
    );
  }
  return null;
}

const QuestionAnswerDbRowSchema = z.object({
  request_id: z.string(),
  question: z.string(),
  context: z.string().nullable(),
  status: z.string(),
  options_json: z.string().nullable(),
  allow_freeform: z.number().int(),
  allow_multiple: z.number().int(),
  answer_json: z.string().nullable(),
  answered_by_id: z.string().nullable(),
  answered_by_name: z.string().nullable(),
});

const StoredQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
});

const StoredAnswerSchema = z.object({
  option_ids: z.array(z.string()),
  freeform: z.string().optional(),
});

export interface QuestionAnswerRow {
  requestId: string;
  question: string;
  context: string | null;
  status: string;
  options: Array<z.infer<typeof StoredQuestionOptionSchema>>;
  allowFreeform: boolean;
  allowMultiple: boolean;
  answer: z.infer<typeof StoredAnswerSchema> | null;
  answeredBy: { id: string; name: string } | null;
}

export function loadQuestionAnswerRow(sql: SqlStorage, requestId: string): QuestionAnswerRow | null {
  for (const row of sql.exec(
    `SELECT request_id, question, context, status, options_json, allow_freeform, allow_multiple,
       answer_json, answered_by_id, answered_by_name
     FROM questions
     WHERE request_id = ?`,
    requestId,
  )) {
    const result = QuestionAnswerDbRowSchema.safeParse(row);
    if (!result.success) return null;
    const parsed = result.data;
    const options = parseStoredJson(parsed.options_json, z.array(StoredQuestionOptionSchema), []);
    const answer = parseStoredJson(parsed.answer_json, StoredAnswerSchema, null);
    const answeredBy = parsed.answered_by_id && parsed.answered_by_name
      ? { id: parsed.answered_by_id, name: parsed.answered_by_name }
      : null;
    return {
      requestId: parsed.request_id,
      question: parsed.question,
      context: parsed.context,
      status: parsed.status,
      options,
      allowFreeform: parsed.allow_freeform === 1,
      allowMultiple: parsed.allow_multiple === 1,
      answer,
      answeredBy,
    };
  }
  return null;
}

function parseStoredJson<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (raw === null) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function listOpenQuestionIds(sql: SqlStorage, runId: string): string[] {
  const ids: string[] = [];
  for (const row of sql.exec(
    `SELECT request_id FROM questions WHERE run_id = ? AND status = 'open'`,
    runId,
  )) {
    const parsed = parseSqliteRow(
      RequestIdRowSchema,
      row,
      "sqlite_question_id",
    );
    if (parsed) ids.push(parsed.request_id);
  }
  return ids;
}
