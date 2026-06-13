import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/session-store";

export function ConflictPanel() {
  const planRevision = useSessionStore((state) => state.planRevision);
  const conflicts = useSessionStore((state) => state.conflicts);
  const currentUserId = useSessionStore((state) => state.currentUserId);
  const sessionCreatorId = useSessionStore((state) => state.sessionCreatorId);
  const resolveConflict = useSessionStore((state) => state.resolveConflict);

  const openConflicts = useMemo(() => {
    if (!planRevision) return [];
    return conflicts.filter((conflict) =>
      conflict.run_id === planRevision.runId
      && conflict.round === planRevision.round
      && conflict.status === "open",
    );
  }, [conflicts, planRevision]);

  if (!planRevision || openConflicts.length === 0) return null;

  const canDecide = Boolean(currentUserId && sessionCreatorId && currentUserId === sessionCreatorId);

  return (
    <section className="conflict-panel" aria-label="Plan feedback conflicts">
      <div className="conflict-panel-header">
        <div>
          <p className="conflict-panel-eyebrow">Decision needed</p>
          <h3 className="conflict-panel-title">Conflicting feedback</h3>
        </div>
        <span className="conflict-panel-count">{openConflicts.length}</span>
      </div>
      {!canDecide && (
        <p className="conflict-panel-note">
          Waiting for the session creator to choose one comment or write a deciding instruction.
        </p>
      )}
      <div className="conflict-panel-list">
        {openConflicts.map((conflict) => (
          <ConflictCard
            key={conflict.id}
            conflictId={conflict.id}
            summary={conflict.summary}
            options={conflict.options}
            canDecide={canDecide}
            onResolve={resolveConflict}
          />
        ))}
      </div>
    </section>
  );
}

interface ConflictCardProps {
  conflictId: string;
  summary: string;
  options: Array<{ thread_id: string; gist: string }>;
  canDecide: boolean;
  onResolve: (
    conflictId: string,
    resolution: { selectedThreadId?: string; decidingInstruction?: string },
  ) => void;
}

function ConflictCard({
  conflictId,
  summary,
  options,
  canDecide,
  onResolve,
}: ConflictCardProps) {
  const [instruction, setInstruction] = useState("");

  function handleResolveSelection(threadId: string) {
    onResolve(conflictId, { selectedThreadId: threadId });
  }

  function handleResolveInstruction(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed) return;
    onResolve(conflictId, { decidingInstruction: trimmed });
    setInstruction("");
  }

  return (
    <article className="conflict-card">
      <p className="conflict-card-summary">{summary}</p>
      <div className="conflict-option-list">
        {options.map((option) => (
          <button
            key={option.thread_id}
            type="button"
            className="conflict-option-button"
            onClick={() => handleResolveSelection(option.thread_id)}
            disabled={!canDecide}
          >
            <span className="conflict-option-label">Use comment</span>
            <span className="conflict-option-gist">{option.gist}</span>
          </button>
        ))}
      </div>
      <form className="conflict-instruction-form" onSubmit={handleResolveInstruction}>
        <textarea
          className="conflict-instruction-textarea"
          placeholder="Write the deciding instruction for the agent"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          disabled={!canDecide}
        />
        <div className="conflict-instruction-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canDecide || instruction.trim().length === 0}
          >
            Send instruction
          </button>
        </div>
      </form>
    </article>
  );
}
