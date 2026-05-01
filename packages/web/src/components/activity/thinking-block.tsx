import { useState } from "react";
import type { ActivityEntry } from "@/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ThinkingBlockProps {
  entry: ActivityEntry;
}

export function ThinkingBlock({ entry }: ThinkingBlockProps) {
  const [open, setOpen] = useState(entry.status === "running");
  if (!entry.thinking) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="activity-thinking-trigger">
        <StatusDot status={entry.status} />
        <span>Agent turn</span>
        <span className="activity-tool-summary">{entry.thinking.text.split("\n").find(Boolean) ?? "Assistant output"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="activity-thinking">
          <Markdown remarkPlugins={[remarkGfm]}>{entry.thinking.text}</Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "running") {
    return <span className="status-dot status-dot-running" />;
  }
  if (status === "success") {
    return <span className="status-dot status-dot-success" />;
  }
  return <span className="status-dot status-dot-error" />;
}
