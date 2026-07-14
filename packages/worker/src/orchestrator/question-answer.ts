import type { ParticipantIdentity } from "@codevil/shared";
import type { OrchestratorHost } from "./host.js";
import { loadQuestionAnswerRow, type QuestionAnswerRow } from "./questions-store.js";

export type IntegrationQuestionAnswerResult =
  | {
      ok: true;
      status: "answered" | "already_answered";
      question: string;
      selectedLabels: string[];
      answeredBy: ParticipantIdentity;
    }
  | {
      ok: false;
      status: "not_found" | "not_open" | "invalid_selection";
      error: string;
    };

interface AnswerQuestionInput {
  requestId: string;
  actor: ParticipantIdentity;
  optionIndexes?: number[];
  optionIds?: string[];
  freeform?: string;
}

export function answerQuestionFromIntegration(
  host: OrchestratorHost,
  args: {
    requestId: string;
    optionIndexes: number[];
    actor: ParticipantIdentity;
    idempotencyKey: string;
  },
): IntegrationQuestionAnswerResult {
  return applyQuestionAnswer(host, {
    requestId: args.requestId,
    optionIndexes: args.optionIndexes,
    actor: args.actor,
  });
}

export function applyQuestionAnswer(
  host: OrchestratorHost,
  input: AnswerQuestionInput,
): IntegrationQuestionAnswerResult {
  const question = loadQuestionAnswerRow(host.sql, input.requestId);
  if (!question) return { ok: false, status: "not_found", error: "Question not found" };
  if (question.status === "answered") return existingAnswer(question);
  if (question.status !== "open") {
    return { ok: false, status: "not_open", error: "Question is no longer open" };
  }

  const selection = validateSelection(question, input);
  if (!selection.ok) return selection;

  const now = new Date().toISOString();
  const answerJson = JSON.stringify({
    option_ids: selection.optionIds,
    ...(selection.freeform !== undefined ? { freeform: selection.freeform } : {}),
  });
  host.sql.exec(
    `UPDATE questions
     SET status = 'answered', answer_json = ?, answered_by_id = ?, answered_by_name = ?, answered_at = ?
     WHERE request_id = ? AND status = 'open'`,
    answerJson,
    input.actor.id,
    input.actor.name,
    now,
    input.requestId,
  );
  host.appendAndBroadcast({
    type: "question_answered",
    request_id: input.requestId,
    option_ids: selection.optionIds,
    ...(selection.freeform !== undefined ? { freeform: selection.freeform } : {}),
    answered_by: input.actor,
    answered_at: now,
  });
  host.sendToSandbox({
    type: "ask_question_response",
    request_id: input.requestId,
    option_ids: selection.optionIds,
    ...(selection.freeform !== undefined ? { freeform: selection.freeform } : {}),
    answered_by: input.actor,
  });
  return {
    ok: true,
    status: "answered",
    question: question.question,
    selectedLabels: labelsForAnswer(question, selection.optionIds, selection.freeform),
    answeredBy: input.actor,
  };
}

function validateSelection(
  question: QuestionAnswerRow,
  input: AnswerQuestionInput,
): { ok: true; optionIds: string[]; freeform?: string } | Extract<IntegrationQuestionAnswerResult, { ok: false }> {
  let optionIds: string[];
  if (input.optionIndexes) {
    if (input.optionIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= question.options.length)) {
      return { ok: false, status: "invalid_selection", error: "Invalid question option" };
    }
    optionIds = input.optionIndexes.map((index) => question.options[index].id);
  } else {
    optionIds = input.optionIds ?? [];
  }
  optionIds = [...new Set(optionIds)];
  const knownIds = new Set(question.options.map((option) => option.id));
  if (optionIds.some((id) => !knownIds.has(id))) {
    return { ok: false, status: "invalid_selection", error: "Invalid question option" };
  }
  if (!question.allowMultiple && optionIds.length > 1) {
    return { ok: false, status: "invalid_selection", error: "Question accepts one option" };
  }
  const freeform = input.freeform?.trim() || undefined;
  if (freeform && !question.allowFreeform) {
    return { ok: false, status: "invalid_selection", error: "Question does not accept free-form input" };
  }
  if (optionIds.length === 0 && !freeform) {
    return { ok: false, status: "invalid_selection", error: "Answer must select an option or include text" };
  }
  return { ok: true, optionIds, ...(freeform ? { freeform } : {}) };
}

function existingAnswer(question: QuestionAnswerRow): IntegrationQuestionAnswerResult {
  if (!question.answer || !question.answeredBy) {
    return { ok: false, status: "not_open", error: "Question has no readable accepted answer" };
  }
  return {
    ok: true,
    status: "already_answered",
    question: question.question,
    selectedLabels: labelsForAnswer(question, question.answer.option_ids, question.answer.freeform),
    answeredBy: question.answeredBy,
  };
}

function labelsForAnswer(question: QuestionAnswerRow, optionIds: string[], freeform?: string): string[] {
  const labels = optionIds.map((id) => question.options.find((option) => option.id === id)?.label ?? id);
  if (labels.length === 0 && freeform) labels.push(freeform);
  return labels;
}
