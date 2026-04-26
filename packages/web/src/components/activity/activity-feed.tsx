import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ToolCard } from "./tool-card";
import { ThinkingBlock } from "./thinking-block";
import { PhaseDivider } from "./phase-divider";
import type { ActivityEntry } from "@/types";

interface ActivityFeedProps {
  entries: ActivityEntry[];
}

export function ActivityFeed({ entries }: ActivityFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [entries.length, autoScroll, scrollToBottom]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(atBottom);
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Agent activity will appear here.</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="border-b px-4 py-2">
        <h3 className="text-sm font-medium">Activity</h3>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-2 py-2"
        onScroll={handleScroll}
      >
        {entries.map((entry) => {
          switch (entry.kind) {
            case "tool_call":
              return <ToolCard key={entry.id} entry={entry} />;
            case "thinking":
              return <ThinkingBlock key={entry.id} entry={entry} />;
            case "phase_divider":
              return <PhaseDivider key={entry.id} entry={entry} />;
          }
        })}
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
