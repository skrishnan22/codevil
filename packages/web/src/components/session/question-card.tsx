import { useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { QuestionViewModel } from "@/stores/session-store";
import type { ParticipantIdentity } from "@codevil/shared";
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
  const participants = useSessionStore((s) => s.participants);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const assignQuestion = useSessionStore((s) => s.assignQuestion);

  if (isConflictQuestion(question, annotations)) {
    return <ConflictDecisionCard question={question} />;
  }

  if (question.status === "answered") {
    return <GenericAnsweredQuestionItem question={question} />;
  }

  const canAnswer = canAnswerQuestion(
    question.answerableBy,
    currentUserId,
    sessionCreatorId,
    question.assignedTo?.id,
  );
  const waitingHint = waitingHintForQuestion(question, canAnswer);
  const assignableParticipants = participants.filter((participant) => participant.id !== sessionCreatorId);
  const canAssign = Boolean(currentUserId && sessionCreatorId && currentUserId === sessionCreatorId);

  return (
    <GenericOpenQuestionItem
      question={question}
      canAnswer={canAnswer}
      canAssign={canAssign}
      assignableParticipants={assignableParticipants}
      waitingHint={waitingHint}
      onAnswer={answerQuestion}
      onAssign={assignQuestion}
    />
  );
}

// ─── Generic open question ─────────────────────────────────────────────────

interface GenericOpenQuestionItemProps {
  question: QuestionViewModel;
  canAnswer: boolean;
  canAssign: boolean;
  assignableParticipants: ParticipantIdentity[];
  waitingHint: string | null;
  onAnswer: (requestId: string, answer: { optionIds: string[]; freeform?: string }) => void;
  onAssign: (requestId: string, participant: ParticipantIdentity) => void;
}

function GenericOpenQuestionItem({
  question,
  canAnswer,
  canAssign,
  assignableParticipants,
  waitingHint,
  onAnswer,
  onAssign,
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

  function handleAssign(e: React.ChangeEvent<HTMLSelectElement>) {
    const participant = assignableParticipants.find((item) => item.id === e.target.value);
    if (participant) onAssign(question.requestId, participant);
  }

  return (
    <article className="question-card">
      <p className="question-card-text">{question.question}</p>
      {question.context && (
        <p className="question-card-context">{question.context}</p>
      )}
      {question.assignedTo && (
        <p className="question-panel-note">
          Assigned to {participantLabel(question.assignedTo)}
        </p>
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
          {canAssign && assignableParticipants.length > 0 && (
            <label className="question-assignee-label">
              <span>Assign to</span>
              <select
                className="question-assignee-select"
                value={question.assignedTo?.id ?? ""}
                onChange={handleAssign}
              >
                <option value="" disabled>Choose teammate</option>
                {assignableParticipants.map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {participantLabel(participant)}
                  </option>
                ))}
              </select>
            </label>
          )}
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

function participantLabel(participant: ParticipantIdentity): string {
  return participant.name ?? participant.id;
}

function waitingHintForQuestion(question: QuestionViewModel, canAnswer: boolean): string | null {
  if (canAnswer) return null;
  if (question.answerableBy === "assigned") {
    return question.assignedTo
      ? `Waiting for ${participantLabel(question.assignedTo)} to answer.`
      : "Waiting for the assigned participant to answer.";
  }
  if (question.answerableBy === "decider") return "Waiting for the session creator to answer.";
  return "Waiting for a participant to answer.";
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
