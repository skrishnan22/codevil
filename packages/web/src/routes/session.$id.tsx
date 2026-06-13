import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { loadConfig } from "@/lib/config";
import { getSession, getAuthMe } from "@/lib/api-client";
import {
  getInitialWorkspaceTab,
  getWorkspaceTabAfterPreviewToggle,
  getWorkspaceTabAfterUserSelection,
  type WorkspaceTab,
} from "@/lib/workspace-state";
import { SessionTopBar } from "@/components/session/session-top-bar";
import { Timeline } from "@/components/session/Timeline";
import { ChatInput } from "@/components/session/ChatInput";
import { WorkspacePane } from "@/components/session/workspace-pane";
import { RoomHeader } from "@/components/session/room-header";
import { PlanReviewPanel } from "@/components/session/plan-review-panel";
import { openThreadsSorted } from "@/lib/annotation-predicates";
import { revisionKey, shouldAutoOpen } from "@/lib/plan-review";

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const {
    connectToSession,
    disconnect,
    setCurrentUserId,
    setSessionCreatorId,
    preview,
    planRevision,
    annotations,
  } = useSessionStore();
  const previewOn = preview.status === "starting" || preview.status === "ready";
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>(() =>
    getInitialWorkspaceTab(previewOn),
  );
  const [previousPreviewOn, setPreviousPreviewOn] = useState(previewOn);

  // Panel open/close state.
  const [panelOpen, setPanelOpen] = useState(false);

  // Track the last revision key for which we auto-opened the panel. Stored in
  // a ref so it doesn't cause extra renders.
  const lastAutoOpenedKey = useRef<string | null>(null);

  useEffect(() => {
    const config = loadConfig();
    if (config) {
      void getSession(config, id)
        .then((session) => {
          setSessionCreatorId(session.session.created_by?.id ?? null);
          connectToSession(config, id, session.ws_url);
        })
        .catch(() => {
          setSessionCreatorId(null);
          const wsUrl = `${config.endpoint}/sessions/${id}/ws`;
          connectToSession(config, id, wsUrl);
        });
      void getAuthMe(config).then((auth) => {
        setCurrentUserId(auth.user?.id ?? null);
      }).catch(() => {
        // Auth lookup is best-effort; silently ignore failures.
      });
    }
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (previewOn === previousPreviewOn) return;
    setActiveWorkspaceTab((current) => getWorkspaceTabAfterPreviewToggle({ current, previewOn }));
    setPreviousPreviewOn(previewOn);
  }, [previewOn, previousPreviewOn]);

  // Auto-open the panel once whenever a new plan revision arrives.
  useEffect(() => {
    if (!planRevision) return;
    const key = revisionKey(planRevision.runId, planRevision.round);
    if (shouldAutoOpen(lastAutoOpenedKey.current, key)) {
      lastAutoOpenedKey.current = key;
      setPanelOpen(true);
    }
  }, [planRevision?.runId, planRevision?.round]);

  function handleSelectWorkspaceTab(tab: WorkspaceTab) {
    setActiveWorkspaceTab(getWorkspaceTabAfterUserSelection(tab));
  }

  function handleOpenActivity(activityId: string) {
    setSelectedActivityId(activityId);
    setActiveWorkspaceTab("activity");
  }

  // Compute open-annotation count for the trigger card summary.
  const openCount = planRevision
    ? openThreadsSorted(annotations, planRevision.runId, planRevision.round).length
    : 0;

  return (
    <div className="session-shell">
      <SessionTopBar />
      <div className="session-workbench">
        <section className="conversation-pane" aria-label="Conversation">
          <RoomHeader />
          {planRevision && (
            <div className="plan-trigger-card">
              <div className="plan-trigger-card-copy">
                <span className="plan-trigger-card-label">
                  Plan ready · Round {planRevision.round + 1}
                  {openCount > 0 && (
                    <> · {openCount} {openCount === 1 ? "comment" : "comments"}</>
                  )}
                </span>
                {planRevision.locked && (
                  <span className="plan-trigger-card-locked">Locked</span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary plan-trigger-card-btn"
                onClick={() => setPanelOpen(true)}
              >
                Review &amp; annotate
              </button>
            </div>
          )}
          <Timeline
            onOpenActivity={handleOpenActivity}
          />
          <ChatInput />
        </section>
        <WorkspacePane
          activeTab={activeWorkspaceTab}
          onSelectTab={handleSelectWorkspaceTab}
          selectedActivityId={selectedActivityId}
          onSelectActivity={setSelectedActivityId}
        />
      </div>

      {/* Full-screen slide-out panel — PlanRevisionView lives here ONLY */}
      {planRevision && panelOpen && (
        <PlanReviewPanel onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
