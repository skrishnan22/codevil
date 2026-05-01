import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToolCard } from "./tool-card";
import { ThinkingBlock } from "./thinking-block";
import { PhaseDivider } from "./phase-divider";
import type { ActivityEntry } from "@/types";
import { ChevronRight } from "lucide-react";

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
  }, [entries, autoScroll, scrollToBottom]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(atBottom);
  }

  if (entries.length === 0) {
    return (
      <div className="activity-panel">
        <div className="activity-header">
          <div>
            <div className="eyebrow">Inspector</div>
            <h3>Agent details</h3>
          </div>
        </div>
        <div className="activity-empty">
          Waiting for agent events.
        </div>
      </div>
    );
  }

  return (
    <div className="activity-panel">
      <div className="activity-header">
        <div>
          <div className="eyebrow">Inspector</div>
          <h3>Agent details</h3>
        </div>
        <span className="activity-count">{entries.length}</span>
      </div>
      <div
        ref={containerRef}
        className="activity-scroll"
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
            case "event":
              return <EventRow key={entry.id} entry={entry} />;
          }
        })}
        <div ref={bottomRef} />
      </div>

      {!autoScroll && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button size="sm" variant="secondary" onClick={scrollToBottom}>
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

function EventRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  if (!entry.event) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="activity-event-trigger">
        <ChevronRight className="activity-disclosure" aria-hidden="true" />
        <span className="status-dot status-dot-success" />
        <span>{entry.event.label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="activity-event">
          {entry.event.detail ? (
            <pre>{entry.event.detail}</pre>
          ) : (
            <pre>{new Date(entry.timestamp).toLocaleTimeString()}</pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
