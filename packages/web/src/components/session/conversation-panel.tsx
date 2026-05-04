import { useSessionStore } from "@/stores/session-store";
import { useState } from "react";
import type { ChatMessage } from "@/types";

export function ConversationPanel() {
  const { messages, sessionPhase, refine } = useSessionStore();
  const [input, setInput] = useState("");

  const chatMessages = messages.filter((m) => m.variant !== "plan");

  return (
    <div>
      <div className="subhead">
        <span className="subhead-label">Conversation</span>
        <span className="subhead-meta">{chatMessages.length} messages</span>
      </div>
      
      <div className="chat-list">
        {chatMessages.map((msg) => (
          <div className={`msg ${messageClass(msg)}`} key={msg.id}>
            <div className="msg-meta">
              <span className="msg-from">{messageSender(msg)}</span>
              &middot;
              <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="msg-bubble">
              {messageContent(msg)}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input">
        <input 
          type="text" 
          placeholder="Ask a question or provide feedback..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              refine(input);
              setInput("");
            }
          }}
          disabled={sessionPhase !== "awaiting_approval" && sessionPhase !== "planning"}
        />
        <div className="kbd">↵</div>
      </div>
    </div>
  );
}

function messageClass(message: ChatMessage): string {
  if (message.role === "user") return "msg-you";
  if (message.variant === "error" || message.variant === "verification_failed") return "msg-error";
  if (message.variant === "complete") return "msg-complete";
  return "msg-agent";
}

function messageSender(message: ChatMessage): string {
  if (message.role === "user") return "You";
  if (message.variant === "error") return "Error";
  if (message.variant === "verification_failed") return "Verification";
  if (message.variant === "complete") return "Session";
  return "Agent";
}

function messageContent(message: ChatMessage): string {
  if (message.variant === "verification_failed" && message.meta?.last_error) {
    return `${message.content}\n${message.meta.last_error}`;
  }
  if (message.variant === "complete" && message.meta?.pr_url) {
    return `${message.content} ${message.meta.pr_url}`;
  }
  return message.content;
}
