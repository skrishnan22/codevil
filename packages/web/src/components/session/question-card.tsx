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
  const [freeformOpen, setFreeformOpen] = useState(false);

  const hasOptions = Boolean(question.options && question.options.length > 0);
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
    <article className="ask-msg">
      <div className="ask-msg-avatar" aria-hidden="true">C</div>
      <div className="ask-msg-body">
        <div className="ask-msg-meta">
          <span className="ask-msg-name">Codevil</span>
          <span className="ask-msg-pill">
            <span aria-hidden="true">✦</span> asks
          </span>
          <span className="ask-msg-time">{formatAskMeta(question)}</span>
        </div>
        <h3 className="ask-msg-question">{question.question}</h3>
        {question.context && <p className="ask-msg-context">{question.context}</p>}
        {question.assignedTo && (
          <p className="ask-msg-note">Assigned to {participantLabel(question.assignedTo)}</p>
        )}
        {waitingHint && <p className="ask-msg-note">{waitingHint}</p>}
        <form className="ask-msg-form" onSubmit={handleSubmit}>
          {hasOptions && (
            <div className="ask-msg-options">
              {question.options!.map((opt) => {
                const selected = selectedIds.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ask-opt${selected ? " is-selected" : ""}`}
                    onClick={() => toggleOption(opt.id)}
                    disabled={!canAnswer}
                    aria-pressed={selected}
                  >
                    <span className="ask-opt-row">
                      <span className="ask-opt-check" aria-hidden="true" />
                      <span className="ask-opt-title">{opt.label}</span>
                    </span>
                    {opt.detail && <p className="ask-opt-desc">{opt.detail}</p>}
                  </button>
                );
              })}
            </div>
          )}

          {question.allowFreeform && (!hasOptions || freeformOpen) && (
            <textarea
              className="ask-msg-freeform"
              placeholder="Type your answer…"
              value={freeform}
              onChange={(e) => setFreeform(e.target.value)}
              rows={3}
              disabled={!canAnswer}
            />
          )}

          <div className="ask-msg-actions">
            {canAssign && assignableParticipants.length > 0 && (
              <label className="ask-msg-assign">
                <span>Assign to</span>
                <select
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
              className="ask-msg-submit"
              disabled={!canAnswer || !hasSelection}
            >
              Submit answer
            </button>
            {question.allowFreeform && hasOptions && !freeformOpen && (
              <button
                type="button"
                className="ask-msg-freeform-toggle"
                onClick={() => setFreeformOpen(true)}
              >
                Or type your own answer ↓
              </button>
            )}
          </div>
        </form>
      </div>
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

function formatAskMeta(question: QuestionViewModel): string {
  if (question.assignedTo) {
    return `assigned to ${participantLabel(question.assignedTo)}`;
  }
  if (question.answerableBy === "decider") return "session creator only";
  if (question.answerableBy === "assigned") return "assigned participant only";
  return "anyone in session";
}

// ─── Generic answered question ─────────────────────────────────────────────

function GenericAnsweredQuestionItem({ question }: { question: QuestionViewModel }) {
  const [expanded, setExpanded] = useState(false);
  const { answer, options } = question;
  if (!answer) return null;

  const chosenLabels =
    options && answer.optionIds.length > 0
      ? answer.optionIds
          .map((id) => options.find((o) => o.id === id)?.label ?? id)
          .join(", ")
      : null;
  const answerSummary = chosenLabels ?? answer.freeform ?? "—";
  const answeredBy = answer.answeredBy.name ?? answer.answeredBy.id;

  return (
    <article className="ask-msg ask-msg--answered">
      <div className="ask-msg-avatar" aria-hidden="true">C</div>
      <div className="ask-msg-body">
        <div className="ask-msg-meta">
          <span className="ask-msg-name">Codevil</span>
          <span className="ask-msg-pill">
            <span aria-hidden="true">✦</span> asks
          </span>
        </div>
        <div className={`ask-answered${expanded ? " is-expanded" : ""}`}>
          <div className="ask-answered-row">
            <span className="ask-answered-tag">
              <span className="ask-answered-check" aria-hidden="true">✓</span>
              Answered
            </span>
            <span className="ask-answered-summary">
              <strong>{answerSummary}</strong>
              <span className="ask-answered-by"> · {answeredBy}</span>
            </span>
            <button
              type="button"
              className="ask-answered-toggle"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? "Hide" : "Show"}
            </button>
          </div>
          {expanded && (
            <div className="ask-answered-detail">
              <h3 className="ask-answered-question">{question.question}</h3>
              {question.context && <p className="ask-msg-context">{question.context}</p>}
              {chosenLabels && answer.freeform && (
                <p className="ask-answered-note">{answer.freeform}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
