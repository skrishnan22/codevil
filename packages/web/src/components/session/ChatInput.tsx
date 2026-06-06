import { useState } from "react";
import { useSessionStore } from "@/stores/session-store";

export function ChatInput() {
  const { connectionStatus, sendRoomMessage } = useSessionStore();
  const [input, setInput] = useState("");

  const canSend = connectionStatus === "connected" || connectionStatus === "connecting";

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || !canSend) return;
    sendRoomMessage(trimmed);
    setInput("");
  }

  return (
    <div className="chat-input-bar">
      <div className="chat-input-bar-inner">
        <input
          id="session-chat-input"
          type="text"
          placeholder="Message the room or tag @codevil..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          disabled={!canSend}
          autoComplete="off"
        />
        <button
          id="session-chat-send"
          className="chat-input-send"
          onClick={handleSend}
          disabled={!canSend || !input.trim()}
          type="button"
        >
          Send ↵
        </button>
      </div>
      <div className={`chat-connection-status ${connectionStatus}`}>
        <span aria-hidden="true" />
        {connectionStatus === "connecting" ? "Reconnecting. Messages will send when connected." : connectionStatus}
      </div>
    </div>
  );
}
