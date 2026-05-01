import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { SplitPane } from "@/components/layout/split-pane";
import { ChatThread } from "@/components/chat/chat-thread";
import { PlanMessage } from "@/components/chat/plan-message";
import { PromptInput } from "@/components/chat/prompt-input";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { useSessionStore } from "@/stores/session-store";
import { loadConfig } from "@/lib/config";
import { Badge } from "@/components/ui/badge";
import type { ChatMessage } from "@/types";

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const {
    messages,
    activityLog,
    sessionPhase,
    connectionStatus,
    planApproved,
    approve,
    abort,
    refine,
    connectToSession,
    disconnect,
  } = useSessionStore();

  useEffect(() => {
    const config = loadConfig();
    if (config) {
      const wsUrl = `${config.endpoint}/sessions/${id}/ws`;
      connectToSession(config, id, wsUrl);
    }
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function renderPlan(message: ChatMessage) {
    return (
      <PlanMessage
        message={message}
        approved={planApproved}
        onApprove={approve}
        onAbort={abort}
        onRefine={refine}
      />
    );
  }

  const leftPanel = (
    <div className="session-panel session-panel-left">
      <div className="session-panel-header">
        <div className="min-w-0">
          <div className="eyebrow">Session</div>
          <div className="truncate font-mono text-sm font-semibold">{id.slice(0, 18)}</div>
        </div>
        <ConnectionBadge status={connectionStatus} />
        {sessionPhase && <Badge variant="outline" className="text-xs">{formatPhase(sessionPhase)}</Badge>}
      </div>
      <ChatThread messages={messages} planComponent={renderPlan} />
      <PromptInput
        onSubmit={refine}
        disabled={sessionPhase !== "awaiting_approval"}
        placeholder={
          sessionPhase === "awaiting_approval"
            ? "Send refinement feedback..."
            : "Watching session..."
        }
      />
    </div>
  );

  const rightPanel = <ActivityFeed entries={activityLog} />;

  return (
    <div className="session-shell">
      <SplitPane left={leftPanel} right={rightPanel} />
    </div>
  );
}

function ConnectionBadge({ status }: { status: string }) {
  const variant = status === "connected" ? "default" : status === "error" ? "destructive" : "secondary";
  return <Badge variant={variant} className="text-xs">{status}</Badge>;
}

function formatPhase(phase: string): string {
  return phase.replaceAll("_", " ");
}
