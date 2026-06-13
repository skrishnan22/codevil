/**
 * PlanReviewPanel
 *
 * Full-screen slide-out overlay that hosts the collaborative plan annotation
 * surface (PlanRevisionView + ConflictPanel + AnnotationPanel + action bar).
 *
 * Layout guarantee:
 *   - The panel is `display:flex; flex-direction:column; height:100vh`.
 *   - Header and Footer are `flex:none` — they never shrink.
 *   - Body is `flex:1; min-height:0; overflow-y:auto` — it scrolls and absorbs
 *     all remaining space, so the footer is ALWAYS visible.
 *
 * Single-mount guarantee:
 *   Render `<PlanReviewPanel>` only when `panelOpen` is true (see session.$id.tsx).
 *   When closed the component is unmounted, which tears down the highlighter
 *   inside PlanRevisionView cleanly. The parent must NOT render PlanRevisionView
 *   anywhere else while this panel can be open.
 */

import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { openThreadsSorted, canSendToAgent, sendToAgentLabel } from "@/lib/annotation-predicates";
import { PlanRevisionView } from "./plan-revision-view";
import { ConflictPanel } from "./conflict-panel";
import { AnnotationPanel } from "./annotation-panel";

interface PlanReviewPanelProps {
  onClose: () => void;
}

export function PlanReviewPanel({ onClose }: PlanReviewPanelProps) {
  const planRevision = useSessionStore((state) => state.planRevision);
  const annotations = useSessionStore((state) => state.annotations);
  const refine = useSessionStore((state) => state.refine);
  const approve = useSessionStore((state) => state.approve);

  const [agentNote, setAgentNote] = useState("");

  // Close on Escape key.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!planRevision) return null;

  const locked = planRevision.locked;
  const openCount = openThreadsSorted(annotations, planRevision.runId, planRevision.round).length;
  const sendEnabled = canSendToAgent(openCount, agentNote, locked);
  const sendLabel = sendToAgentLabel(openCount);

  function handleSendToAgent() {
    if (!sendEnabled) return;
    refine(agentNote.trim());
    setAgentNote("");
  }

  return (
    <>
      {/* Backdrop — click to close */}
      <div
        className="plan-review-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="plan-review-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Plan collaboration"
      >
        {/* ── Header (flex:none) ── */}
        <div className="plan-review-panel-header">
          <div className="plan-review-panel-header-copy">
            <p className="plan-collab-eyebrow">Plan collaboration</p>
            <h2 className="plan-review-panel-title">Round {planRevision.round + 1}</h2>
          </div>
          <div className="plan-review-panel-header-right">
            <span className={`plan-collab-state${locked ? " is-locked" : ""}`}>
              {locked ? "Locked" : "Open for comments"}
            </span>
            {openCount > 0 && (
              <span className="plan-review-panel-comment-count">
                {openCount} {openCount === 1 ? "comment" : "comments"}
              </span>
            )}
            <button
              type="button"
              className="plan-slideout-close"
              onClick={onClose}
              aria-label="Close plan review"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Body (flex:1, scrolls) ── */}
        <div className="plan-review-panel-body">
          <PlanRevisionView />
          <ConflictPanel />
          <AnnotationPanel />
        </div>

        {/* ── Footer (flex:none, always visible) ── */}
        {!locked && (
          <div className="plan-review-panel-footer">
            <input
              className="plan-collab-note-input"
              type="text"
              placeholder="Optional note to agent…"
              value={agentNote}
              onChange={(e) => setAgentNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sendEnabled) handleSendToAgent();
              }}
            />
            <button
              className="btn btn-primary"
              onClick={handleSendToAgent}
              disabled={!sendEnabled}
              title={sendEnabled ? undefined : "Add a comment or note to send"}
            >
              {sendLabel}
            </button>
            <button
              className="btn btn-ghost"
              onClick={approve}
              title="Approve the plan and start execution"
            >
              Approve
            </button>
            {!sendEnabled && (
              <span className="plan-collab-hint">Add a comment or note to send</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
