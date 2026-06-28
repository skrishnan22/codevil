import {
  parseSqliteRow,
  QuestionRowSchema,
  RequestIdRowSchema,
  type QuestionRow,
} from "@codevil/shared";

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
      row as Record<string, unknown>,
      "sqlite_question",
    );
  }
  return null;
}

export function listOpenQuestionIds(sql: SqlStorage, runId: string): string[] {
  const ids: string[] = [];
  for (const row of sql.exec(
    `SELECT request_id FROM questions WHERE run_id = ? AND status = 'open'`,
    runId,
  )) {
    const parsed = parseSqliteRow(
      RequestIdRowSchema,
      row as Record<string, unknown>,
      "sqlite_question_id",
    );
    if (parsed) ids.push(parsed.request_id);
  }
  return ids;
}
