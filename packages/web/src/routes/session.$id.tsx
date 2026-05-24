import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { loadConfig } from "@/lib/config";
import { SessionTopBar } from "@/components/session/session-top-bar";
import { StatusStrip } from "@/components/session/StatusStrip";
import { Timeline } from "@/components/session/Timeline";
import { ChatInput } from "@/components/session/ChatInput";
import { PlanSlideOut } from "@/components/session/PlanSlideOut";
import { LivePreview } from "@/components/session/live-preview";

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const { connectToSession, disconnect } = useSessionStore();
  const [planOpen, setPlanOpen] = useState(false);

  useEffect(() => {
    const config = loadConfig();
    if (config) {
      const wsUrl = `${config.endpoint}/sessions/${id}/ws`;
      connectToSession(config, id, wsUrl);
    }
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="session-shell">
      <SessionTopBar />
      <div className="session-body">
        <StatusStrip />
        <LivePreview />
        <Timeline onViewPlan={() => setPlanOpen(true)} />
        <ChatInput />
      </div>
      {planOpen && <PlanSlideOut onClose={() => setPlanOpen(false)} />}
    </div>
  );
}
