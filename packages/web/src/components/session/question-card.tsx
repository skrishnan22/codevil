import { useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { QuestionViewModel } from "@/stores/session-store";
import { canAnswerQuestion } from "@/lib/annotation-predicates";
import { isConflictQuestion } from "@/lib/conflict-question";
import { ConflictDecisionCard } from "./conflict-decision-card";

/**
 * Per-question router used when a question is rendered in-stream (Timeline).
 * Picks the rich conflict card for binary annotation conflicts; otherwise
 * delegates to the generic open/answered renderers used for all other
 * `ask_question` calls.
 */
export function QuestionItem({ question }: { question: QuestionViewModel }) {
  const annotations = useSessionStore((s) => s.annotations);
  const currentUserId = useSessionStore((s) => s.currentUserId);
  const sessionCreatorId = useSessionStore((s) => s.sessionCreatorId);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);

  if (isConflictQuestion(question, annotations)) {
    return <ConflictDecisionCard question={question} />;
  }

  if (question.status === "answered") {
    return <GenericAnsweredQuestionItem question={question} />;
  }

  const canAnswer = canAnswerQuestion(question.answerableBy, currentUserId, sessionCreatorId);
  const waitingHint = canAnswer
    ? null
    : question.answerableBy === "decider"
      ? "Waiting for the session creator to answer."
      : "Waiting for a participant to answer.";

  return (
    <GenericOpenQuestionItem
      question={question}
      canAnswer={canAnswer}
      waitingHint={waitingHint}
      onAnswer={answerQuestion}
    />
  );
}

// ─── Generic open question ─────────────────────────────────────────────────

interface GenericOpenQuestionItemProps {
  question: QuestionViewModel;
  canAnswer: boolean;
  waitingHint: string | null;
  onAnswer: (requestId: string, answer: { optionIds: string[]; freeform?: string }) => void;
}

function GenericOpenQuestionItem({
  question,
  canAnswer,
  waitingHint,
  onAnswer,
}: GenericOpenQuestionItemProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [freeform, setFreeform] = useState("");

  const hasOptions = question.options && question.options.length > 0;
  const hasSelection = selectedIds.length > 0 || freeform.trim().length > 0;

  function toggleOption(id: string) {
    if (question.allowMultiple) {
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    } else {
      setSelectedIds((prev) => (prev[0] === id ? [] : [id]));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasSelection) return;
    onAnswer(question.requestId, {
      optionIds: selectedIds,
      freeform: freeform.trim() || undefined,
    });
  }

  return (
    <article className="question-card">
      <p className="question-card-text">{question.question}</p>
      {question.context && (
        <p className="question-card-context">{question.context}</p>
      )}
      {waitingHint && (
        <p className="question-panel-note">{waitingHint}</p>
      )}
      <form className="question-card-form" onSubmit={handleSubmit}>
        {hasOptions && (
          <div className="question-option-list">
            {question.options!.map((opt) => {
              const selected = selectedIds.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`question-option-button${selected ? " question-option-button--selected" : ""}`}
                  onClick={() => toggleOption(opt.id)}
                  disabled={!canAnswer}
                  aria-pressed={selected}
                >
                  <span className="question-option-label">{opt.label}</span>
                  {opt.detail && (
                    <span className="question-option-detail">{opt.detail}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {question.allowFreeform && (
          <textarea
            className="question-freeform-textarea"
            placeholder="Type your answer…"
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            rows={3}
            disabled={!canAnswer}
          />
        )}
        <div className="question-card-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canAnswer || !hasSelection}
          >
            Submit answer
          </button>
        </div>
      </form>
    </article>
  );
}

// ─── Generic answered question ─────────────────────────────────────────────

function GenericAnsweredQuestionItem({ question }: { question: QuestionViewModel }) {
  const { answer, options } = question;
  if (!answer) return null;

  const chosenLabels =
    options && answer.optionIds.length > 0
      ? answer.optionIds
          .map((id) => options.find((o) => o.id === id)?.label ?? id)
          .join(", ")
      : null;

  return (
    <article className="question-card question-card--answered">
      <p className="question-card-text">{question.question}</p>
      <div className="question-card-answer">
        {chosenLabels && (
          <p className="question-answer-choice">{chosenLabels}</p>
        )}
        {answer.freeform && (
          <p className="question-answer-freeform">{answer.freeform}</p>
        )}
        <p className="question-answer-meta">
          Answered by {answer.answeredBy.name ?? answer.answeredBy.id}
        </p>
      </div>
    </article>
  );
}
