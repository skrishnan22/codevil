/**
 * AnnotationPanel
 *
 * Side panel listing the open annotation threads for the current plan
 * revision. Allows anyone to reply (when unlocked) and authors to withdraw
 * their own threads (when unlocked). Selection is kept in sync with inline
 * highlights via `selectedAnnotationId` / `selectAnnotation`.
 */

import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { canWithdraw, canReply, openThreadsSorted } from "@/lib/annotation-predicates";
import type { AnnotationThread } from "@codevil/shared";

export function AnnotationPanel() {
  const planRevision = useSessionStore((state) => state.planRevision);
  const annotations = useSessionStore((state) => state.annotations);
  const selectedAnnotationId = useSessionStore((state) => state.selectedAnnotationId);
  const selectAnnotation = useSessionStore((state) => state.selectAnnotation);
  const replyToAnnotation = useSessionStore((state) => state.replyToAnnotation);
  const withdrawAnnotation = useSessionStore((state) => state.withdrawAnnotation);
  const currentUserId = useSessionStore((state) => state.currentUserId);

  if (!planRevision) return null;

  const locked = planRevision.locked;
  const threads = openThreadsSorted(annotations, planRevision.runId, planRevision.round);

  if (threads.length === 0) return null;

  return (
    <div className="annotation-panel" aria-label="Annotation threads">
      <div className="annotation-panel-header">
        <span className="annotation-panel-title">Comments</span>
        <span className="annotation-panel-count">{threads.length}</span>
      </div>
      <div className="annotation-panel-list">
        {threads.map((thread) => (
          <ThreadItem
            key={thread.id}
            thread={thread}
            isSelected={thread.id === selectedAnnotationId}
            locked={locked}
            currentUserId={currentUserId}
            onSelect={() => selectAnnotation(thread.id)}
            onReply={(comment) => replyToAnnotation(thread.id, comment)}
            onWithdraw={() => withdrawAnnotation(thread.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface ThreadItemProps {
  thread: AnnotationThread;
  isSelected: boolean;
  locked: boolean;
  currentUserId: string | null;
  onSelect: () => void;
  onReply: (comment: string) => void;
  onWithdraw: () => void;
}

function ThreadItem({
  thread,
  isSelected,
  locked,
  currentUserId,
  onSelect,
  onReply,
  onWithdraw,
}: ThreadItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const [replyText, setReplyText] = useState("");

  const showWithdraw = canWithdraw(thread, currentUserId, locked);
  const showReply = canReply(locked);

  // Scroll selected thread into view when selection changes.
  useEffect(() => {
    if (isSelected && itemRef.current) {
      itemRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isSelected]);

  function handleReplySubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(trimmed);
    setReplyText("");
  }

  function handleReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      const trimmed = replyText.trim();
      if (trimmed) {
        onReply(trimmed);
        setReplyText("");
      }
    }
  }

  return (
    <div
      ref={itemRef}
      className={`annotation-thread-item${isSelected ? " is-selected" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      aria-pressed={isSelected}
    >
      <div className="annotation-thread-meta">
        <span className="annotation-thread-author">{thread.author.name}</span>
        <span className="annotation-thread-anchor" title={thread.anchor.text}>
          line {thread.anchor.sourceLine}
        </span>
      </div>

      <blockquote className="annotation-thread-quote">{thread.anchor.text}</blockquote>

      <p className="annotation-thread-comment">{thread.comment}</p>

      {thread.replies && thread.replies.length > 0 && (
        <div className="annotation-thread-replies">
          {thread.replies.map((reply) => (
            <div key={reply.id} className="annotation-reply">
              <span className="annotation-reply-author">{reply.author.name}</span>
              <span className="annotation-reply-comment">{reply.comment}</span>
            </div>
          ))}
        </div>
      )}

      {showReply && (
        <form
          className="annotation-reply-form"
          onSubmit={handleReplySubmit}
          onClick={(e) => e.stopPropagation()}
        >
          <textarea
            className="annotation-reply-textarea"
            placeholder="Reply…"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleReplyKeyDown}
            rows={2}
          />
          <div className="annotation-reply-actions">
            <button
              type="submit"
              className="btn btn-primary annotation-reply-submit"
              disabled={!replyText.trim()}
            >
              Reply
            </button>
            {showWithdraw && (
              <button
                type="button"
                className="btn btn-ghost annotation-withdraw-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onWithdraw();
                }}
              >
                Withdraw
              </button>
            )}
          </div>
        </form>
      )}

    </div>
  );
}
