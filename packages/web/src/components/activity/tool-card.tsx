import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ActivityEntry } from "@/types";
import { ChevronRight } from "lucide-react";

interface ToolCardProps {
  entry: ActivityEntry;
}

export function ToolCard({ entry }: ToolCardProps) {
  const [open, setOpen] = useState(entry.status === "running");
  if (!entry.tool) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="activity-tool-trigger">
        <ChevronRight className="activity-disclosure" aria-hidden="true" />
        <StatusDot status={entry.status} />
        <span className="activity-tool-name">{entry.tool.name}</span>
        <span className="activity-tool-summary">{entry.tool.summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="activity-tool-body">
          {entry.tool.args && (
            <pre>{entry.tool.args}</pre>
          )}
          {entry.tool.result && (
            <pre>{entry.tool.result}</pre>
          )}
          {entry.tool.error && (
            <pre className="text-destructive">{entry.tool.error}</pre>
          )}
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
