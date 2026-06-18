import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { parseAgentMention } from "@/stores/session-store";
import { shouldDisableChatInput } from "@/lib/conflict-question";

const CHAT_INPUT_GATE_HINT_ID = "chat-input-gate-hint";
const MAX_HEIGHT_PX = 160;

export function ChatInput() {
  const { sessionId, connectionStatus, sendRoomMessage, questions, annotations } =
    useSessionStore();
  const [input, setInput] = useState("");
  const [mentionOn, setMentionOn] = useState<boolean>(() => {
    if (typeof window === "undefined" || !sessionId) return false;
    return Boolean(sessionStorage.getItem("codevil-composer-mention-" + sessionId));
  });
  const [planOn, setPlanOn] = useState<boolean>(() => {
    if (typeof window === "undefined" || !sessionId) return false;
    return Boolean(sessionStorage.getItem("codevil-composer-plan-" + sessionId));
  });
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const conflictGate = shouldDisableChatInput(questions, annotations);
  const canSend =
    !conflictGate.disabled &&
    (connectionStatus === "connected" || connectionStatus === "connecting");

  // Persist chip state per session.
  useEffect(() => {
    if (!sessionId) return;
    sessionStorage.setItem(
      "codevil-composer-mention-" + sessionId,
      mentionOn ? "1" : "",
    );
  }, [mentionOn, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    sessionStorage.setItem(
      "codevil-composer-plan-" + sessionId,
      planOn ? "1" : "",
    );
  }, [planOn, sessionId]);

  // Plan chip auto-flips off when mention chip flips off.
  useEffect(() => {
    if (!mentionOn && planOn) setPlanOn(false);
  }, [mentionOn, planOn]);

  // Textarea autosize.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT_PX) + "px";
  }, [input]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || !canSend) return;
    let text = trimmed;
    if (mentionOn && !parseAgentMention(text)) {
      text = "@codevil " + text;
    }
    const planFirst = planOn && (mentionOn || parseAgentMention(text) !== null);
    sendRoomMessage(text, { planFirst });
    setInput("");
    setPlanOn(false);
  }

  return (
    <div className={`composer-pill-wrap${focused ? " is-focused" : ""}`}>
      <div className="composer-pill">
        <button
          type="button"
          className={`composer-chip composer-chip--mention${mentionOn ? " is-on" : ""}`}
          onClick={() => {
            if (conflictGate.disabled) return;
            setMentionOn((v) => !v);
          }}
          aria-pressed={mentionOn}
          disabled={conflictGate.disabled || !canSend}
        >
          <span aria-hidden="true">@</span>codevil
        </button>
        <button
          type="button"
          className={`composer-chip composer-chip--plan${planOn && mentionOn ? " is-on" : ""}`}
          onClick={() => {
            if (conflictGate.disabled || !mentionOn) return;
            setPlanOn((v) => !v);
          }}
          aria-pressed={planOn && mentionOn}
          disabled={conflictGate.disabled || !mentionOn || !canSend}
        >
          <span aria-hidden="true">✦</span> Plan
        </button>
        <textarea
          id="session-chat-input"
          ref={textareaRef}
          className="composer-input"
          rows={1}
          placeholder={
            conflictGate.disabled
              ? "Resolve the decision above to continue."
              : "Message the room…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={!canSend}
          aria-describedby={
            conflictGate.disabled ? CHAT_INPUT_GATE_HINT_ID : undefined
          }
          autoComplete="off"
        />
        <button
          type="button"
          id="session-chat-send"
          className="composer-send"
          onClick={handleSend}
          disabled={!canSend || !input.trim()}
          aria-label="Send message"
        >
          <span aria-hidden="true">↑</span>
        </button>
      </div>
      {focused && !conflictGate.disabled && (
        <div className="composer-caption">
          <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
        </div>
      )}
      {conflictGate.disabled && (
        <div
          className="composer-caption is-blocked"
          id={CHAT_INPUT_GATE_HINT_ID}
        >
          {conflictGate.hint}
        </div>
      )}
    </div>
  );
}
