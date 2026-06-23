import type { AnswerableBy } from "@codevil/shared";

export interface QuestionRow {
  run_id: string;
  status: string;
  answerable_by: AnswerableBy;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
}

export function questionAnswerDeniedMessage(question: {
  answerable_by: AnswerableBy;
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
    return {
      run_id: row["run_id"] as string,
      status: row["status"] as string,
      answerable_by: row["answerable_by"] as AnswerableBy,
      assigned_to_id: (row["assigned_to_id"] as string | null) ?? null,
      assigned_to_name: (row["assigned_to_name"] as string | null) ?? null,
    };
  }
  return null;
}

export function listOpenQuestionIds(sql: SqlStorage, runId: string): string[] {
  const ids: string[] = [];
  for (const row of sql.exec(
    `SELECT request_id FROM questions WHERE run_id = ? AND status = 'open'`,
    runId,
  )) {
    ids.push(row["request_id"] as string);
  }
  return ids;
}
