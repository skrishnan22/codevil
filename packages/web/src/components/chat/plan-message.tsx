import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { ChatMessage } from "@/types";
import { normalizePlanMarkdown } from "@/lib/plan-markdown";
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
  const hasPlan = message.content.trim().length > 0;
  const markdown = normalizePlanMarkdown(message.content);

  function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    if (feedback.trim()) {
      onRefine(feedback.trim());
      setFeedback("");
    }
  }

  return (
    <div className="plan-surface">
      <div className="plan-header">
        <div>
          <div className="eyebrow">Plan ready</div>
          <h2>Review before execution</h2>
        </div>
        {approved && <Badge variant="default">Approved</Badge>}
      </div>

      {message.meta?.cost && (
        <p className="plan-meta">
          Cost: ${message.meta.cost.total_cost_usd.toFixed(2)} ({message.meta.cost.input_tokens} in / {message.meta.cost.output_tokens} out)
          {message.meta.refinement_round ? ` | Round ${message.meta.refinement_round}` : ""}
        </p>
      )}

      <div className="plan-document">
        {hasPlan ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>
          </div>
        ) : (
          <div className="empty-plan">
            Plan content was empty. The session returned an approval checkpoint without a readable plan.
          </div>
        )}
      </div>

      {approved ? (
        <div className="plan-approved-note">
          Execution has started from this approved plan.
        </div>
      ) : (
        <div className="plan-actions">
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
