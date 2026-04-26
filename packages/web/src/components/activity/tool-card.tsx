import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ActivityEntry } from "@/types";

interface ToolCardProps {
  entry: ActivityEntry;
}

export function ToolCard({ entry }: ToolCardProps) {
  const [open, setOpen] = useState(entry.status === "running");
  if (!entry.tool) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
        <StatusDot status={entry.status} />
        <span className="font-mono text-xs font-medium">{entry.tool.name}</span>
        <span className="truncate text-xs text-muted-foreground">{entry.tool.summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 mt-1 mb-2">
          {entry.tool.args && (
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{entry.tool.args}</pre>
          )}
          {entry.tool.result && (
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{entry.tool.result}</pre>
          )}
          {entry.tool.error && (
            <pre className="mt-1 rounded bg-destructive/10 p-2 text-xs text-destructive">{entry.tool.error}</pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "running") {
    return <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />;
  }
  if (status === "success") {
    return <span className="h-2 w-2 rounded-full bg-green-500" />;
  }
  return <span className="h-2 w-2 rounded-full bg-red-500" />;
}
