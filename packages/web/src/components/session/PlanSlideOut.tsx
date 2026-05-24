import { useSessionStore } from "@/stores/session-store";
import { normalizePlanMarkdown } from "@/lib/plan-markdown";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PlanSlideOutProps {
  onClose: () => void;
}

export function PlanSlideOut({ onClose }: PlanSlideOutProps) {
  const { messages, sessionPhase, planApproved, approve, abort, refine } = useSessionStore();
  const [feedback, setFeedback] = useState("");

  const planMessage = [...messages].reverse().find((m) => m.variant === "plan");
  const content = planMessage
    ? normalizePlanMarkdown(planMessage.content || "No plan description provided.")
    : "No plan available yet.";

  const showActions = !planApproved && sessionPhase === "awaiting_approval";

  function handleApprove() {
    approve();
    onClose();
  }

  function handleAbort() {
    abort();
    onClose();
  }

  function handleRefine() {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    refine(trimmed);
    setFeedback("");
  }

  return (
    <>
      <div
        className="plan-slideout-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="plan-slideout"
        role="dialog"
        aria-modal="true"
        aria-label="Implementation Plan"
      >
        <div className="plan-slideout-head">
          <div className="plan-slideout-title">Implementation Plan</div>
          <button
            id="plan-slideout-close"
            className="plan-slideout-close"
            onClick={onClose}
            type="button"
            aria-label="Close plan"
          >
            ✕
          </button>
        </div>

        <div className="plan-slideout-body scroll">
          <div className="plan-row">
            <div className="plan-row-head">
              <span className="plan-row-num">1</span>
              <span className="plan-row-label">Overview</span>
            </div>
            <div className="plan-row-body plan-body">
              <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            </div>
          </div>

          {planMessage?.meta && (
            <div className="plan-row">
              <div className="plan-row-head">
                <span className="plan-row-num">2</span>
                <span className="plan-row-label">Context</span>
              </div>
              <div className="plan-row-body plan-kv">
                <div className="plan-kv-row">
                  <span className="plan-kv-k">Cost</span>
                  <span className="plan-kv-v">
                    {planMessage.meta.cost
                      ? `$${planMessage.meta.cost.total_cost_usd.toFixed(4)}`
                      : "unknown"}
                  </span>
                </div>
                <div className="plan-kv-row">
                  <span className="plan-kv-k">Tokens</span>
                  <span className="plan-kv-v">
                    {planMessage.meta.cost
                      ? `${planMessage.meta.cost.input_tokens.toLocaleString()} in / ${planMessage.meta.cost.output_tokens.toLocaleString()} out`
                      : "unknown"}
                  </span>
                </div>
                <div className="plan-kv-row">
                  <span className="plan-kv-k">Round</span>
                  <span className="plan-kv-v">{planMessage.meta.refinement_round ?? 0}</span>
                </div>
              </div>
            </div>
          )}

        </div>

        {showActions && (
          <div className="plan-actions plan-slideout-actions">
            <button id="plan-slideout-approve" className="btn btn-primary" onClick={handleApprove}>
              Approve &amp; execute
            </button>
            <button className="btn btn-ghost" onClick={handleAbort}>Abort</button>
            <input
              type="text"
              className="plan-refine"
              placeholder="Refinement feedback..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRefine();
              }}
            />
            <button
              className="btn btn-secondary"
              onClick={handleRefine}
              disabled={!feedback.trim()}
            >
              Refine
            </button>
          </div>
        )}
      </div>
    </>
  );
}
