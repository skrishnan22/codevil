import { useEffect, useMemo } from "react";
import type { ActivityEntry } from "@/types";
import { useSessionStore } from "@/stores/session-store";
import { DetailPanel } from "./detail-panel";

interface ActivityTabProps {
  selectedActivityId: string | null;
  onSelectActivity: (id: string | null) => void;
}

export function ActivityTab({ selectedActivityId, onSelectActivity }: ActivityTabProps) {
  const { activityLog } = useSessionStore();
  const entries = useMemo(
    () => activityLog.filter((entry) =>
      entry.kind === "tool_call" ||
      entry.kind === "thinking" ||
      entry.kind === "event" ||
      entry.kind === "phase_divider"
    ),
    [activityLog],
  );

  useEffect(() => {
    if (entries.length === 0) return;
    if (selectedActivityId && entries.some((entry) => entry.id === selectedActivityId)) return;
    onSelectActivity(entries.at(-1)!.id);
  }, [entries, onSelectActivity, selectedActivityId]);

  if (entries.length === 0) {
    return (
      <div className="activity-empty-state">
        <div className="activity-empty-mark" aria-hidden="true">A</div>
        <div>
          <div className="activity-empty-title">Agent activity will appear here</div>
          <div className="activity-empty-copy">Thinking, tool calls, outputs, and verification stay out of the conversation and remain inspectable here.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-tab">
      <div className="activity-list scroll">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`activity-row${selectedActivityId === entry.id ? " active" : ""}`}
            onClick={() => onSelectActivity(entry.id)}
          >
            <span className="activity-row-kind">{entry.kind.replace("_", " ")}</span>
            <span className="activity-row-copy">
              <span className="activity-row-title">{activityTitle(entry)}</span>
              <span className="activity-row-preview">{activityPreview(entry)}</span>
            </span>
            <span className={`activity-row-status ${entry.status}`}>{entry.status}</span>
          </button>
        ))}
      </div>
      <DetailPanel selectedCallId={selectedActivityId} />
    </div>
  );
}

function activityPreview(entry: ActivityEntry): string {
  if (entry.kind === "tool_call") return entry.tool?.result || entry.tool?.args || entry.tool?.name || "";
  if (entry.kind === "thinking") return entry.thinking?.text || "";
  if (entry.kind === "event") return entry.event?.detail || "";
  return entry.phase?.label || "";
}

function activityTitle(entry: ActivityEntry): string {
  if (entry.kind === "tool_call") return entry.tool?.summary || entry.tool?.name || "Tool call";
  if (entry.kind === "thinking") return entry.thinking?.text?.slice(0, 90).trim() || "Assistant stream";
  if (entry.kind === "event") return entry.event?.label || "Event";
  return entry.phase?.label || "Activity";
}
