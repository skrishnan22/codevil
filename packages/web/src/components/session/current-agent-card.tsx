import { useSessionStore } from "@/stores/session-store";
import { deriveCurrentAgent } from "@/lib/current-agent";

interface CurrentAgentCardProps {
  onOpenActivity: (activityId: string) => void;
}

export function CurrentAgentCard({ onOpenActivity }: CurrentAgentCardProps) {
  const { messages, activityLog, sessionPhase, planApproved } = useSessionStore();
  const current = deriveCurrentAgent({ messages, activityLog, sessionPhase, planApproved });

  return (
    <section className={`current-agent-card current-agent-${current.kind}`} aria-label="Current agent focus">
      <div className="current-agent-head">
        <div className="current-agent-copy">
          <div className="current-agent-eyebrow">Current agent</div>
          <h2 className="current-agent-title">{current.title}</h2>
        </div>
        {current.badge && <span className="current-agent-badge">{current.badge}</span>}
      </div>

      {current.description && (
        <div className="current-agent-description">{current.description}</div>
      )}

      <div className="current-agent-actions">
        {current.activityId && (
          <button type="button" onClick={() => onOpenActivity(current.activityId!)}>
            Open in Activity
          </button>
        )}
      </div>
    </section>
  );
}
