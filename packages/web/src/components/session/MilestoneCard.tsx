interface MilestoneData {
  id: string;
  kind: "plan-approved" | "tests-passing" | "pr-created" | "complete";
  title: string;
  subtitle?: string;
  timestamp: number;
  action?: { label: string; handler: () => void };
}

interface MilestoneCardProps {
  milestone: MilestoneData;
}

function getIcon(kind: MilestoneData["kind"]): { emoji: string; cls: string } {
  switch (kind) {
    case "plan-approved": return { emoji: "✓", cls: "plan" };
    case "tests-passing": return { emoji: "✓", cls: "tests" };
    case "pr-created": return { emoji: "⌥", cls: "pr" };
    case "complete": return { emoji: "✓", cls: "complete" };
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MilestoneCard({ milestone }: MilestoneCardProps) {
  const { emoji, cls } = getIcon(milestone.kind);

  return (
    <div className="milestone-card" id={`milestone-${milestone.id}`}>
      <div className={`milestone-icon ${cls}`} aria-hidden="true">
        {emoji}
      </div>
      <div className="milestone-body">
        <div className="milestone-title">{milestone.title}</div>
        {milestone.subtitle && (
          <div className="milestone-subtitle">{milestone.subtitle}</div>
        )}
      </div>
      {milestone.action && (
        <button
          className="milestone-action"
          onClick={milestone.action.handler}
          type="button"
        >
          {milestone.action.label} →
        </button>
      )}
      <div className="milestone-ts">{formatTime(milestone.timestamp)}</div>
    </div>
  );
}

export type { MilestoneData };
