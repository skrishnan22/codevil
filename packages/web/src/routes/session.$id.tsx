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

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const { connectToSession, disconnect, setCurrentUserId, preview } = useSessionStore();
  const previewOn = preview.status === "starting" || preview.status === "ready";
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>(() =>
    getInitialWorkspaceTab(previewOn),
  );
  const [previousPreviewOn, setPreviousPreviewOn] = useState(previewOn);

  useEffect(() => {
    const config = loadConfig();
    if (config) {
      void getSession(config, id)
        .then((session) => connectToSession(config, id, session.ws_url))
        .catch(() => {
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

  return (
    <div className="session-shell">
      <SessionTopBar />
      <div className="session-workbench">
        <section className="conversation-pane" aria-label="Conversation">
          <RoomHeader />
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
