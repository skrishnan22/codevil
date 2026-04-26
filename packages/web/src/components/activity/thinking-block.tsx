import type { ActivityEntry } from "@/types";

interface ThinkingBlockProps {
  entry: ActivityEntry;
}

export function ThinkingBlock({ entry }: ThinkingBlockProps) {
  if (!entry.thinking) return null;

  return (
    <div className="px-2 py-1 text-xs text-muted-foreground italic">
      {entry.thinking.text}
    </div>
  );
}
