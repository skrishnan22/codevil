import { useSessionStore } from "@/stores/session-store";
import { loadStoredSession } from "@/lib/session-summary";

export function TaskHeader() {
  const { messages, sessionId } = useSessionStore();
  const firstUserMessage = messages.find(m => m.role === "user" && m.variant === "text");
  const storedSession = loadStoredSession(sessionId);
  const title = firstUserMessage?.content || storedSession?.title || "Room";

  return (
    <div className="section-header">
      <div className="section-eyebrow">Room</div>
      <div className="section-title-row">
        <h2 className="section-title">{title}</h2>
      </div>
    </div>
  );
}
