import { useState } from "react";
import { useSessionStore } from "@/stores/session-store";

export function ChatInput() {
  const { sessionPhase, refine } = useSessionStore();
  const [input, setInput] = useState("");

  const isDone = sessionPhase === "completed" || sessionPhase === "failed";
  const canRefine = sessionPhase === "awaiting_approval";

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || !canRefine) return;
    refine(trimmed);
    setInput("");
  }

  return (
    <div className="chat-input-bar">
      <div className="chat-input-bar-inner">
        <input
          id="session-chat-input"
          type="text"
          placeholder={
            isDone
              ? "Session is complete"
              : canRefine
              ? "Provide plan feedback..."
              : "Waiting for agent..."
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          disabled={!canRefine}
          autoComplete="off"
        />
        <button
          id="session-chat-send"
          className="chat-input-send"
          onClick={handleSend}
          disabled={!canRefine || !input.trim()}
          type="button"
        >
          Send ↵
        </button>
      </div>
      {canRefine && (
        <div className="chat-input-hint">Enter to send refinement feedback before approval</div>
      )}
    </div>
  );
}
