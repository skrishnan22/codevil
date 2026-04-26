import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { ChatMessage } from "@/types";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PlanMessageProps {
  message: ChatMessage;
  approved: boolean;
  onApprove: () => void;
  onAbort: () => void;
  onRefine: (feedback: string) => void;
}

export function PlanMessage({ message, approved, onApprove, onAbort, onRefine }: PlanMessageProps) {
  const [feedback, setFeedback] = useState("");

  function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    if (feedback.trim()) {
      onRefine(feedback.trim());
      setFeedback("");
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
      </div>

      {message.meta?.cost && (
        <p className="mt-3 text-xs text-muted-foreground">
          Cost: ${message.meta.cost.total_cost_usd.toFixed(2)} ({message.meta.cost.input_tokens} in / {message.meta.cost.output_tokens} out)
          {message.meta.refinement_round ? ` | Round ${message.meta.refinement_round}` : ""}
        </p>
      )}

      {approved ? (
        <div className="mt-3">
          <Badge variant="default">Approved</Badge>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove}>Approve</Button>
            <Button size="sm" variant="destructive" onClick={onAbort}>Abort</Button>
          </div>
          <form onSubmit={handleRefine} className="flex gap-2">
            <Input
              placeholder="Refinement feedback..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!feedback.trim()}>
              Refine
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
