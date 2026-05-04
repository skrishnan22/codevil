import { useSessionStore } from "@/stores/session-store";
import { normalizePlanMarkdown } from "@/lib/plan-markdown";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function PlanCard() {
  const { messages, sessionPhase, planApproved, approve, abort, refine } = useSessionStore();
  const [feedback, setFeedback] = useState("");

  const planMessage = [...messages].reverse().find((m) => m.variant === "plan");
  
  if (!planMessage || sessionPhase !== "awaiting_approval") {
    // Only show the plan card when a plan is ready or approved
    if (sessionPhase === "executing" || sessionPhase === "completed") {
       // if we want to show it in the history, we can, but let's hide or show a readonly version
       if (!planMessage) return null;
    } else {
       return null;
    }
  }

  const content = normalizePlanMarkdown(planMessage.content || "No plan description provided.");

  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <div className={`chip ${planApproved ? 'solid' : 'accent'}`}>
          <span className={`dot ${planApproved ? 'ok' : 'info pulse'}`}></span>
          {planApproved ? "Plan approved" : "Plan ready · awaiting review"}
        </div>
        <h3 className="plan-title">Implementation Plan</h3>
      </div>
      
      <div className="plan-row">
        <div className="plan-row-head">
          <span className="plan-row-num">1</span>
          <span className="plan-row-label">Overview</span>
        </div>
        <div className="plan-row-body plan-body">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      </div>
      
      <div className="plan-row">
        <div className="plan-row-head">
          <span className="plan-row-num">2</span>
          <span className="plan-row-label">Context</span>
        </div>
        <div className="plan-row-body plan-kv">
          <div className="plan-kv-row">
            <span className="plan-kv-k">Cost</span>
            <span className="plan-kv-v">
              {planMessage.meta?.cost ? `$${planMessage.meta.cost.total_cost_usd.toFixed(4)}` : "unknown"}
            </span>
          </div>
          <div className="plan-kv-row">
            <span className="plan-kv-k">Tokens</span>
            <span className="plan-kv-v">
              {planMessage.meta?.cost
                ? `${planMessage.meta.cost.input_tokens.toLocaleString()} in / ${planMessage.meta.cost.output_tokens.toLocaleString()} out`
                : "unknown"}
            </span>
          </div>
          <div className="plan-kv-row">
            <span className="plan-kv-k">Round</span>
            <span className="plan-kv-v">{planMessage.meta?.refinement_round ?? 0}</span>
          </div>
        </div>
      </div>

      {!planApproved && (
        <div className="plan-actions">
          <button className="btn btn-primary" onClick={() => approve()}>Approve &amp; execute</button>
          <button className="btn btn-ghost" onClick={() => abort()}>Abort</button>
          <input 
            type="text" 
            className="plan-refine" 
            placeholder="Refinement feedback..." 
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && feedback.trim()) {
                refine(feedback);
                setFeedback("");
              }
            }}
          />
          <button 
            className="btn btn-secondary" 
            onClick={() => {
              if (feedback.trim()) {
                refine(feedback);
                setFeedback("");
              }
            }}
          >
            Refine
          </button>
        </div>
      )}
    </div>
  );
}
