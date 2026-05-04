import { InspectorHeader } from "./inspector-header";
import { TurnsList } from "./turns-list";
import { DetailPanel } from "./detail-panel";
import { useSessionStore } from "@/stores/session-store";
import type { ActivityEntry } from "@/types";
import { useMemo, useState } from "react";

const DEFAULT_DRAWER_HEIGHT = 36;
const MIN_DRAWER_HEIGHT = 24;
const MAX_DRAWER_HEIGHT = 70;

export function InspectorPane() {
  const [filter, setFilter] = useState("all");
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(DEFAULT_DRAWER_HEIGHT);
  const { activityLog } = useSessionStore();

  const currentActivity = useMemo(() => findCurrentActivity(activityLog), [activityLog]);

  function handleSelectCall(id: string) {
    setSelectedCallId(id);
  }

  function handleDragStart(event: React.PointerEvent<HTMLDivElement>) {
    const container = event.currentTarget.closest(".insp-workspace");
    if (!(container instanceof HTMLElement)) return;

    const startY = event.clientY;
    const startHeight = drawerHeight;
    const containerHeight = container.getBoundingClientRect().height;

    event.currentTarget.setPointerCapture(event.pointerId);

    function handlePointerMove(moveEvent: PointerEvent) {
      const delta = startY - moveEvent.clientY;
      const nextHeight = startHeight + (delta / containerHeight) * 100;
      setDrawerHeight(Math.min(MAX_DRAWER_HEIGHT, Math.max(MIN_DRAWER_HEIGHT, nextHeight)));
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <div className="rp rp-insp">
      <InspectorHeader filter={filter} onFilterChange={setFilter} />
      <div className="insp-workspace">
        <CurrentActivityStrip entry={currentActivity} onSelect={handleSelectCall} />
        <TurnsList 
          filter={filter} 
          selectedCallId={selectedCallId} 
          onSelectCall={handleSelectCall} 
        />
        {selectedCallId && (
          <div className="insp-drawer" style={{ height: `${drawerHeight}%` }}>
            <div
              className="insp-drawer-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize tool detail drawer"
              onPointerDown={handleDragStart}
            >
              <span />
            </div>
            <DetailPanel selectedCallId={selectedCallId} />
          </div>
        )}
      </div>
    </div>
  );
}

function CurrentActivityStrip({
  entry,
  onSelect,
}: {
  entry: ActivityEntry | null;
  onSelect: (id: string) => void;
}) {
  if (!entry) {
    return (
      <div className="current-activity">
        <div className="current-activity-dot idle" />
        <div className="current-activity-copy">
          <div className="current-activity-title">Waiting for agent activity</div>
          <div className="current-activity-meta">Tool calls and reasoning will appear here as the session runs.</div>
        </div>
      </div>
    );
  }

  const isTool = entry.kind === "tool_call" && entry.tool;
  const isError = entry.status === "error";
  const reasoning = entry.kind === "thinking"
    ? entry.thinking?.text?.trim()
    : entry.tool?.error || entry.tool?.result || entry.event?.detail || "";
  const title = isTool
    ? entry.tool?.summary || entry.tool?.name || "Running tool call"
    : entry.thinking?.text?.trim() || entry.event?.label || entry.phase?.label || "Agent is working";
  const meta = isTool
    ? `${entry.tool?.name ?? "tool"} · ${entry.status}`
    : `${entry.kind.replace("_", " ")} · ${entry.status}`;

  return (
    <button
      className={`current-activity ${isError ? "current-activity-error" : ""}`}
      onClick={() => onSelect(entry.id)}
      type="button"
    >
      <div className={`current-activity-dot ${entry.status === "running" ? "running" : isError ? "error" : "ok"}`} />
      <div className="current-activity-copy">
        <div className="current-activity-eyebrow">
          {entry.status === "running" ? "Agent is currently doing" : isError ? "Needs attention" : "Latest activity"}
        </div>
        <div className="current-activity-title">{title}</div>
        {reasoning && <div className="current-activity-reasoning">{reasoning}</div>}
        <div className="current-activity-meta">{meta}</div>
      </div>
    </button>
  );
}

function findCurrentActivity(activityLog: ActivityEntry[]): ActivityEntry | null {
  const running = [...activityLog].reverse().find((entry) => entry.status === "running");
  if (running) return running;

  const error = [...activityLog].reverse().find((entry) => entry.status === "error");
  if (error) return error;

  return [...activityLog].reverse().find((entry) => entry.kind === "tool_call" || entry.kind === "thinking") ?? null;
}
