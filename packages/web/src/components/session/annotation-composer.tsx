/**
 * AnnotationComposer
 *
 * Lightweight inline composer shown when a user selects text in the plan
 * revision.  Renders a small textarea + Comment / Cancel buttons as a
 * floating box anchored near the bottom of the viewport.
 *
 * Props:
 *  - onSubmit(comment) — called with non-empty trimmed comment text
 *  - onCancel          — called when user cancels or submits empty text
 */

import { useState, type FormEvent } from "react";

interface AnnotationComposerProps {
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

export function AnnotationComposer({ onSubmit, onCancel }: AnnotationComposerProps) {
  const [text, setText] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      onCancel();
    }
    // Cmd/Ctrl+Enter submits
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed);
      else onCancel();
    }
  }

  return (
    <div className="annotation-composer" role="dialog" aria-label="Add annotation">
      <form onSubmit={handleSubmit}>
        <textarea
          className="annotation-composer-textarea"
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          autoFocus
        />
        <div className="annotation-composer-actions">
          <button
            type="submit"
            className="btn btn-primary annotation-composer-submit"
            disabled={!text.trim()}
          >
            Comment
          </button>
          <button
            type="button"
            className="btn btn-ghost annotation-composer-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
