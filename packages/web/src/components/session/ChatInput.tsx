import { useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { parseAgentMention } from "@/stores/session-store";
import { shouldDisableChatInput } from "@/lib/conflict-question";

const CHAT_INPUT_GATE_HINT_ID = "chat-input-gate-hint";

export function ChatInput() {
  const { connectionStatus, sendRoomMessage, questions, annotations } = useSessionStore();
  const [input, setInput] = useState("");
  const [planFirst, setPlanFirst] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const conflictGate = shouldDisableChatInput(questions, annotations);
  const canSend =
    !conflictGate.disabled &&
    (connectionStatus === "connected" || connectionStatus === "connecting");
  const isAgentRequest = parseAgentMention(input) !== null;
  const connectionLabel = conflictGate.disabled
    ? conflictGate.hint!
    : connectionStatus === "connecting"
      ? "Reconnecting. Messages will send when connected."
      : connectionStatus;

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || !canSend) return;
    sendRoomMessage(trimmed, { planFirst: planFirst && isAgentRequest });
    setInput("");
    setPlanFirst(false);
  }

  function handleMention() {
    setInput((current) => {
      if (/@codevil\b/i.test(current)) return current;
      const prefix = current.length === 0 || current.endsWith(" ") ? current : `${current} `;
      return `${prefix}@codevil `;
    });
    textareaRef.current?.focus();
  }

  return (
    <div className="chat-input-bar">
      <div className="chat-input-bar-inner">
        <div className="chat-input-avatar" aria-hidden="true">Y</div>
        <textarea
          id="session-chat-input"
          ref={textareaRef}
          placeholder={
            conflictGate.disabled
              ? "Resolve the decision above to continue."
              : "Message the room — tag @codevil to direct the agent"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={!canSend}
          aria-describedby={conflictGate.disabled ? CHAT_INPUT_GATE_HINT_ID : undefined}
          autoComplete="off"
        />
        <div className="chat-input-tools">
          <button
            type="button"
            className="chat-input-mention"
            onClick={handleMention}
            disabled={!canSend}
          >
            @ Mention Codevil
          </button>
          <label className={`chat-input-plan-first ${!isAgentRequest ? "is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={planFirst}
              onChange={(e) => setPlanFirst(e.target.checked)}
              disabled={!canSend || !isAgentRequest}
            />
            Plan first
          </label>
          <span className="chat-input-hint">
            <kbd>↵</kbd> to send · <kbd>⇧↵</kbd> for newline
          </span>
        </div>
        <button
          id="session-chat-send"
          className="chat-input-send"
          onClick={handleSend}
          disabled={!canSend || !input.trim()}
          type="button"
          aria-label="Send message"
        >
          ↑
        </button>
      </div>
      <div
        className={`chat-connection-status ${conflictGate.disabled ? "blocked" : connectionStatus}`}
        id={conflictGate.disabled ? CHAT_INPUT_GATE_HINT_ID : undefined}
      >
        <span aria-hidden="true" />
        {connectionLabel}
      </div>
    </div>
  );
}
