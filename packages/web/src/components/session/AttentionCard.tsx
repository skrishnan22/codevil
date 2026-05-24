interface AttentionAction {
  label: string;
  primary?: boolean;
  handler: () => void;
}

interface AttentionData {
  id: string;
  kind: "approval-needed" | "verification-failed" | "error" | "waiting-input";
  title: string;
  description: string;
  actions: AttentionAction[];
}

interface AttentionCardProps {
  item: AttentionData;
  highlight?: boolean;
}

function getIcon(kind: AttentionData["kind"]): { emoji: string; cls: string } {
  switch (kind) {
    case "approval-needed": return { emoji: "!", cls: "" };
    case "verification-failed": return { emoji: "⚠", cls: "" };
    case "error": return { emoji: "✕", cls: "error" };
    case "waiting-input": return { emoji: "?", cls: "" };
  }
}

export function AttentionCard({ item, highlight }: AttentionCardProps) {
  const { emoji, cls } = getIcon(item.kind);

  return (
    <div
      className={`attention-card${highlight ? " attention-highlight" : ""}`}
      id={`attention-${item.id}`}
      role="alert"
    >
      <div className="attention-card-head">
        <div className={`attention-icon${cls ? ` ${cls}` : ""}`} aria-hidden="true">
          {emoji}
        </div>
        <div className="attention-body">
          <div className="attention-title">{item.title}</div>
          {item.description && (
            <div className="attention-desc">{item.description}</div>
          )}
        </div>
      </div>
      {item.actions.length > 0 && (
        <div className="attention-actions">
          {item.actions.map((action) => (
            <button
              key={action.label}
              className={`attention-btn${action.primary ? " primary" : ""}`}
              onClick={action.handler}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type { AttentionData, AttentionAction };
