import type { ReactNode } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTab } from "@/lib/workspace-state";
import { ActivityTab } from "./activity-tab";
import { LivePreview } from "./live-preview";

interface WorkspacePaneProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  selectedActivityId: string | null;
  onSelectActivity: (id: string | null) => void;
}

export function WorkspacePane({
  activeTab,
  onSelectTab,
  selectedActivityId,
  onSelectActivity,
}: WorkspacePaneProps) {
  const { preview, sessionPhase } = useSessionStore();
  const previewOn = preview.status === "starting" || preview.status === "ready";

  return (
    <aside className="workspace-pane" aria-label="Session workspace">
      <div className="workspace-pane-head">
        <div className="workspace-tabs" role="tablist" aria-label="Workspace tabs">
          <WorkspaceTabButton tab="activity" activeTab={activeTab} onSelect={onSelectTab}>
            Activity
          </WorkspaceTabButton>
          <WorkspaceTabButton tab="preview" activeTab={activeTab} onSelect={onSelectTab}>
            Preview
            {previewOn && <span className="workspace-tab-dot" aria-hidden="true" />}
          </WorkspaceTabButton>
        </div>
        <div className="workspace-phase-pill">
          <span aria-hidden="true" />
          {phaseLabel(sessionPhase)}
        </div>
      </div>

      <div className="workspace-pane-body">
        {activeTab === "preview" && <LivePreview />}
        {activeTab === "activity" && (
          <ActivityTab selectedActivityId={selectedActivityId} onSelectActivity={onSelectActivity} />
        )}
      </div>
    </aside>
  );
}

function phaseLabel(phase: string | null): string {
  switch (phase) {
    case "planning":
    case "awaiting_approval":
    case "refining":
      return "Drafting plan";
    case "executing":
      return "Executing";
    case "verifying":
    case "retrying":
      return "Verifying";
    case "completed":
      return "Complete";
    case "failed":
      return "Needs attention";
    default:
      return "Activity";
  }
}

function WorkspaceTabButton({
  tab,
  activeTab,
  onSelect,
  children,
}: {
  tab: WorkspaceTab;
  activeTab: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      className={`workspace-tab${activeTab === tab ? " active" : ""}`}
      onClick={() => onSelect(tab)}
    >
      {children}
    </button>
  );
}
