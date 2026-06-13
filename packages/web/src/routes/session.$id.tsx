import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { PlanRevisionView } from "@/components/session/plan-revision-view";
import { AnnotationPanel } from "@/components/session/annotation-panel";
import { ConflictPanel } from "@/components/session/conflict-panel";
import { openThreadsSorted, canSendToAgent, sendToAgentLabel } from "@/lib/annotation-predicates";

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
    refine,
    approve,
  } = useSessionStore();
  const previewOn = preview.status === "starting" || preview.status === "ready";
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>(() =>
    getInitialWorkspaceTab(previewOn),
  );
  const [previousPreviewOn, setPreviousPreviewOn] = useState(previewOn);
  const [agentNote, setAgentNote] = useState("");

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

  function handleSelectWorkspaceTab(tab: WorkspaceTab) {
    setActiveWorkspaceTab(getWorkspaceTabAfterUserSelection(tab));
  }

  function handleOpenActivity(activityId: string) {
    setSelectedActivityId(activityId);
    setActiveWorkspaceTab("activity");
  }

  // Compute open-annotation count for the current plan revision.
  const openCount = planRevision
    ? openThreadsSorted(annotations, planRevision.runId, planRevision.round).length
    : 0;

  const locked = planRevision?.locked ?? false;
  const sendEnabled = canSendToAgent(openCount, agentNote, locked);
  const sendLabel = sendToAgentLabel(openCount);

  function handleSendToAgent() {
    if (!sendEnabled) return;
    refine(agentNote.trim());
    setAgentNote("");
  }

  return (
    <div className="session-shell">
      <SessionTopBar />
      <div className="session-workbench">
        <section className="conversation-pane" aria-label="Conversation">
          <RoomHeader />
          {planRevision && (
            <section className="plan-collab-pane" aria-label="Plan collaboration">
              <div className="plan-collab-header">
                <div>
                  <p className="plan-collab-eyebrow">Plan collaboration</p>
                  <h2 className="plan-collab-title">Round {planRevision.round + 1}</h2>
                </div>
                <span className={`plan-collab-state${planRevision.locked ? " is-locked" : ""}`}>
                  {planRevision.locked ? "Locked" : "Open for comments"}
                </span>
              </div>
              <PlanRevisionView />
              <ConflictPanel />
              <AnnotationPanel />
              {!locked && (
                <div className="plan-collab-actions">
                  <input
                    className="plan-collab-note-input"
                    type="text"
                    placeholder="Optional note to agent…"
                    value={agentNote}
                    onChange={(e) => setAgentNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && sendEnabled) handleSendToAgent();
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleSendToAgent}
                    disabled={!sendEnabled}
                    title={sendEnabled ? undefined : "Add a comment or note to send"}
                  >
                    {sendLabel}
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={approve}
                    title="Approve the plan and start execution"
                  >
                    Approve
                  </button>
                  {!sendEnabled && (
                    <span className="plan-collab-hint">Add a comment or note to send</span>
                  )}
                </div>
              )}
            </section>
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
    </div>
  );
}
