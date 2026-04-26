import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "@/types";

interface ChatThreadProps {
  messages: ChatMessage[];
  planComponent?: (message: ChatMessage) => React.ReactNode;
}

export function ChatThread({ messages, planComponent }: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [messages.length, autoScroll, scrollToBottom]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(atBottom);
  }

  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        onScroll={handleScroll}
      >
        <div className="flex flex-col gap-3">
          {messages.map((msg) =>
            msg.variant === "plan" && planComponent ? (
              <div key={msg.id}>{planComponent(msg)}</div>
            ) : (
              <MessageBubble key={msg.id} message={msg} />
            ),
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {!autoScroll && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
          <Button size="sm" variant="secondary" onClick={scrollToBottom}>
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
