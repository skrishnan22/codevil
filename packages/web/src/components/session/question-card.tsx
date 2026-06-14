import { useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { QuestionViewModel } from "@/stores/session-store";
import { canAnswerQuestion } from "@/lib/annotation-predicates";

export function QuestionCard() {
  const questions = useSessionStore((state) => state.questions);
  const currentUserId = useSessionStore((state) => state.currentUserId);
  const sessionCreatorId = useSessionStore((state) => state.sessionCreatorId);
  const answerQuestion = useSessionStore((state) => state.answerQuestion);

  const openQuestions = questions.filter((q) => q.status === "open");
  const answeredQuestions = questions.filter((q) => q.status === "answered");

  if (questions.length === 0) return null;

  return (
    <section className="question-panel" aria-label="Questions from the agent">
      <div className="question-panel-header">
        <div>
          <p className="question-panel-eyebrow">Input needed</p>
          <h3 className="question-panel-title">Agent question</h3>
        </div>
        {openQuestions.length > 0 && (
          <span className="question-panel-count">{openQuestions.length}</span>
        )}
      </div>
      <div className="question-panel-list">
        {openQuestions.map((q) => {
          const canAnswer = canAnswerQuestion(q.answerableBy, currentUserId, sessionCreatorId);
          const waitingHint =
            q.answerableBy === "decider"
              ? "Waiting for the session creator to answer."
              : "Waiting for a participant to answer.";
          return (
            <OpenQuestionItem
              key={q.requestId}
              question={q}
              canAnswer={canAnswer}
              waitingHint={canAnswer ? null : waitingHint}
              onAnswer={answerQuestion}
            />
          );
        })}
        {answeredQuestions.map((q) => (
          <AnsweredQuestionItem key={q.requestId} question={q} />
        ))}
      </div>
    </section>
  );
}

interface OpenQuestionItemProps {
  question: QuestionViewModel;
  canAnswer: boolean;
  waitingHint: string | null;
  onAnswer: (requestId: string, answer: { optionIds: string[]; freeform?: string }) => void;
}

function OpenQuestionItem({ question, canAnswer, waitingHint, onAnswer }: OpenQuestionItemProps) {
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

interface AnsweredQuestionItemProps {
  question: QuestionViewModel;
}

function AnsweredQuestionItem({ question }: AnsweredQuestionItemProps) {
  const { answer, options } = question;
  if (!answer) return null;

  // Resolve option labels from their ids
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
