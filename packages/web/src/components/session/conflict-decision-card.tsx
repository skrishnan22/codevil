import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { QuestionViewModel } from "@/stores/session-store";
import type { ParticipantIdentity } from "@codevil/shared";
import { canAnswerQuestion } from "@/lib/annotation-predicates";
import {
  type ConflictSide,
  deriveSides,
  openConflictsInOrder,
} from "@/lib/conflict-question";

interface ConflictDecisionCardProps {
  question: QuestionViewModel;
}

export function ConflictDecisionCard({ question }: ConflictDecisionCardProps) {
  const annotations = useSessionStore((s) => s.annotations);
  const questions = useSessionStore((s) => s.questions);
  const currentUserId = useSessionStore((s) => s.currentUserId);
  const sessionCreatorId = useSessionStore((s) => s.sessionCreatorId);
  const participants = useSessionStore((s) => s.participants);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const assignQuestion = useSessionStore((s) => s.assignQuestion);
  const openPlanPanel = useSessionStore((s) => s.openPlanPanel);

  const sides = useMemo(() => deriveSides(question, annotations), [question, annotations]);
  const openQueue = useMemo(
    () => openConflictsInOrder(questions, annotations),
    [questions, annotations],
  );
  const queueIndex = openQueue.findIndex((q) => q.requestId === question.requestId);
  const queueTotal = openQueue.length;
  const canAnswer = canAnswerQuestion(
    question.answerableBy,
    currentUserId,
    sessionCreatorId,
    question.assignedTo?.id,
  );
  const canAssign = Boolean(currentUserId && sessionCreatorId && currentUserId === sessionCreatorId);
  const assignableParticipants = participants.filter((participant) => participant.id !== sessionCreatorId);

  if (question.status === "answered") {
    return <ResolvedSummary question={question} sides={sides} />;
  }

  return (
    <OpenConflictCard
      question={question}
      sides={sides}
      canAnswer={canAnswer}
      queueIndex={queueIndex}
      queueTotal={queueTotal}
      onAnswer={answerQuestion}
      canAssign={canAssign}
      assignableParticipants={assignableParticipants}
      onAssign={assignQuestion}
      onOpenPlan={openPlanPanel}
    />
  );
}

// ─── open state ────────────────────────────────────────────────────────────

interface OpenConflictCardProps {
  question: QuestionViewModel;
  sides: ConflictSide[];
  canAnswer: boolean;
  queueIndex: number;
  queueTotal: number;
  onAnswer: (requestId: string, answer: { optionIds: string[]; freeform?: string }) => void;
  canAssign: boolean;
  assignableParticipants: ParticipantIdentity[];
  onAssign: (requestId: string, participant: ParticipantIdentity) => void;
  onOpenPlan: () => void;
}

function OpenConflictCard({
  question,
  sides,
  canAnswer,
  queueIndex,
  queueTotal,
  onAnswer,
  canAssign,
  assignableParticipants,
  onAssign,
  onOpenPlan,
}: OpenConflictCardProps) {
  const [selectedSideId, setSelectedSideId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedSide = sides.find((s) => s.optionId === selectedSideId) ?? null;
  const commitDisabled = !canAnswer || selectedSideId === null || submitting;
  const commitLabel = selectedSide
    ? `Commit: ${displayChoice(selectedSide)}`
    : "Commit";

  function handleSelect(side: ConflictSide) {
    if (!canAnswer || submitting) return;
    setSelectedSideId((prev) => (prev === side.optionId ? null : side.optionId));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (commitDisabled || selectedSideId === null) return;
    setSubmitting(true);
    onAnswer(question.requestId, {
      optionIds: [selectedSideId],
      freeform: note.trim() || undefined,
    });
    // Submitting stays true until the answered event arrives and this card
    // is replaced by <ResolvedSummary>. If the round is dropped/retried,
    // this component unmounts.
  }

  function handleAssign(e: React.ChangeEvent<HTMLSelectElement>) {
    const participant = assignableParticipants.find((item) => item.id === e.target.value);
    if (participant) onAssign(question.requestId, participant);
  }

  return (
    <article className="ask-msg ask-msg--conflict">
      <div className="ask-msg-avatar" aria-hidden="true">C</div>
      <div className="ask-msg-body">
        <div className="ask-msg-meta">
          <span className="ask-msg-name">Codevil</span>
          <span className="ask-msg-pill ask-msg-pill--decision">
            <span aria-hidden="true">✦</span> decision needed
          </span>
          {queueTotal > 1 && queueIndex >= 0 && (
            <span
              className="ask-msg-pager"
              aria-label={`Decision ${queueIndex + 1} of ${queueTotal}`}
            >
              {queueIndex + 1} of {queueTotal}
            </span>
          )}
        </div>
        <h3 className="ask-msg-question">{question.question}</h3>
        {question.context && (
          <p className="ask-msg-context">{question.context}</p>
        )}
        <form className="conflict-card" onSubmit={handleSubmit}>
      <div className="conflict-card-sides">
        {sides.map((side, i) => (
          <SideButton
            key={side.optionId}
            side={side}
            selected={side.optionId === selectedSideId}
            disabled={!canAnswer || submitting}
            onClick={() => handleSelect(side)}
          >
            {i === 0 && sides.length === 2 && <span className="conflict-vs" aria-hidden="true">vs</span>}
          </SideButton>
        ))}
      </div>

      {noteOpen && (
        <textarea
          className="conflict-card-note"
          placeholder="Optional note for the agent…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          disabled={!canAnswer || submitting}
          aria-label="Note to agent"
        />
      )}

      <div className="conflict-card-actions">
        {!canAnswer && (
          <span className="conflict-card-waiting">
            {waitingHintForQuestion(question)}
          </span>
        )}
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
          type="button"
          className="conflict-card-open-plan"
          onClick={onOpenPlan}
        >
          Open in plan ↗
        </button>
        <button
          type="button"
          className="conflict-card-note-toggle"
          onClick={() => setNoteOpen((v) => !v)}
          disabled={!canAnswer || submitting}
          aria-expanded={noteOpen}
        >
          {noteOpen ? "Hide note" : "Add note…"}
        </button>
        <button
          type="submit"
          className="conflict-card-commit"
          disabled={commitDisabled}
        >
          {submitting ? "Committing…" : commitLabel}
        </button>
      </div>
        </form>
      </div>
    </article>
  );
}

function participantLabel(participant: ParticipantIdentity): string {
  return participant.name ?? participant.id;
}

function waitingHintForQuestion(question: QuestionViewModel): string {
  if (question.answerableBy === "assigned") {
    return question.assignedTo
      ? `Waiting for ${participantLabel(question.assignedTo)} to answer.`
      : "Waiting for the assigned participant to answer.";
  }
  if (question.answerableBy === "anyone") return "Waiting for a participant to answer.";
  return "Waiting for the session creator to answer.";
}

interface SideButtonProps {
  side: ConflictSide;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}

function SideButton({ side, selected, disabled, onClick, children }: SideButtonProps) {
  const authorName = side.author?.name ?? side.author?.id ?? "Unknown";
  const authorInitial = authorName.slice(0, 1).toUpperCase();

  return (
    <>
      <button
        type="button"
        className={`conflict-side${selected ? " is-selected" : ""}`}
        onClick={onClick}
        disabled={disabled}
        aria-pressed={selected}
      >
        <div className="conflict-side-meta">
          <span className="conflict-side-avatar" aria-hidden="true">
            {side.missing ? "?" : authorInitial}
          </span>
          <span className="conflict-side-author">{authorName}</span>
          {side.createdAt && (
            <span className="conflict-side-when">{formatRelative(side.createdAt)}</span>
          )}
          {side.withdrawn && (
            <span className="conflict-side-status">· annotation withdrawn</span>
          )}
          {side.missing && (
            <span className="conflict-side-status">· annotation withdrawn</span>
          )}
        </div>
        <div className="conflict-side-label">{side.label}</div>
        {side.detail && (
          <div className="conflict-side-detail">{side.detail}</div>
        )}
        {side.anchorTextPreview && (
          <div className="conflict-side-anchor">"{side.anchorTextPreview}"</div>
        )}
      </button>
      {children}
    </>
  );
}

// ─── resolved state ────────────────────────────────────────────────────────

interface ResolvedSummaryProps {
  question: QuestionViewModel;
  sides: ConflictSide[];
}

function ResolvedSummary({ question, sides }: ResolvedSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const chosen = question.answer
    ? sides.find((s) => question.answer!.optionIds.includes(s.optionId)) ?? null
    : null;
  const chosenLabel = chosen ? displayChoice(chosen) : "—";

  return (
    <article className="ask-msg ask-msg--conflict ask-msg--answered">
      <div className="ask-msg-avatar" aria-hidden="true">C</div>
      <div className="ask-msg-body">
        <div className="ask-msg-meta">
          <span className="ask-msg-name">Codevil</span>
          <span className="ask-msg-pill ask-msg-pill--decision">
            <span aria-hidden="true">✦</span> decision needed
          </span>
        </div>
        <h3 className="ask-msg-question">{question.question}</h3>
        <div className={`conflict-resolved${expanded ? " is-expanded" : ""}`}>
          <div className="conflict-resolved-row">
            <span className="conflict-resolved-tag">
              <span className="conflict-resolved-check" aria-hidden="true">✓</span>
              Resolved
            </span>
            <span className="conflict-resolved-summary">
              {question.answer
                ? <>Picked <strong>{chosenLabel}</strong></>
                : "Resolved."}
            </span>
            <button
              type="button"
              className="conflict-resolved-toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? "Hide" : "Show"}
            </button>
          </div>
          {expanded && (
            <div className="conflict-resolved-detail">
              <ul className="conflict-resolved-sides">
                {sides.map((s) => {
                  const isChosen = chosen?.optionId === s.optionId;
                  return (
                    <li
                      key={s.optionId}
                      className={`conflict-resolved-side${isChosen ? " is-chosen" : ""}`}
                    >
                      <strong>{s.author?.name ?? "Unknown"}:</strong> {s.label}
                    </li>
                  );
                })}
              </ul>
              {question.answer?.freeform && (
                <p className="conflict-resolved-note">Note: {question.answer.freeform}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

// ─── presentational helpers ────────────────────────────────────────────────

function displayChoice(side: ConflictSide): string {
  const author = side.author?.name;
  return author ? `${author}'s call` : side.label;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
