import { Separator } from "@/components/ui/separator";
import type { ActivityEntry } from "@/types";

interface PhaseDividerProps {
  entry: ActivityEntry;
}

export function PhaseDivider({ entry }: PhaseDividerProps) {
  if (!entry.phase) return null;

  return (
    <div className="flex items-center gap-3 py-2">
      <Separator className="flex-1" />
      <span className="text-xs font-medium text-muted-foreground">{entry.phase.label}</span>
      <Separator className="flex-1" />
    </div>
  );
}
