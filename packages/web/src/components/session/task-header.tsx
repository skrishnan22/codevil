import { useSessionStore } from "@/stores/session-store";
import { loadStoredSession } from "@/lib/session-summary";

export function TaskHeader() {
  // Try to find the first user message for the task title
  const { messages, sessionId } = useSessionStore();
  const firstUserMessage = messages.find(m => m.role === "user" && m.variant === "text");
  const storedSession = loadStoredSession(sessionId);
  const taskTitle = firstUserMessage?.content || storedSession?.prompt || "Running task...";

  return (
    <div className="section-header">
      <div className="section-eyebrow">Task</div>
      <div className="section-title-row">
        <h2 className="section-title">{taskTitle}</h2>
      </div>
    </div>
  );
}
