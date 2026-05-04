import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/session-store";
import { loadConfig } from "@/lib/config";
import { SessionTopBar } from "@/components/session/session-top-bar";
import { LeftPane } from "@/components/session/left-pane";
import { InspectorPane } from "@/components/session/inspector-pane";

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const { connectToSession, disconnect } = useSessionStore();

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
        <LeftPane />
        <InspectorPane />
      </div>
    </div>
  );
}
