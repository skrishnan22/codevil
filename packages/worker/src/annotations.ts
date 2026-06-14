// Pure helpers for annotation data mapping. Kept free of Durable Object state
// so they can be unit-tested without the workerd runtime.

import type { AnnotationThread, ConsolidationAnnotation } from "@codevil/shared";

/**
 * Map loaded annotation threads to the minimal consolidation shape that is
 * sent to the consolidation sandbox agent.
 *
 * Strips raw anchor internals (startMeta/endMeta/blockId) and exposes only the
 * human-readable fields the LLM needs to reason about each annotation.
 */
export function toConsolidationAnnotations(threads: AnnotationThread[]): ConsolidationAnnotation[] {
  return threads.map((thread) => ({
    id: thread.id,
    anchoredQuote: thread.anchor.text,
    sourceLine: thread.anchor.sourceLine,
    authorName: thread.author.name,
    comment: thread.comment,
    replies: (thread.replies ?? []).map((reply) => ({
      authorName: reply.author.name,
      body: reply.comment,
    })),
  }));
}

/**
 * Build a plain-prose refinement brief for the deterministic fast path (no Pi
 * consolidation turn): zero or one open annotation thread. Combines the
 * approver's free-text note with the single thread's comment (and its replies).
 * Falls back to a generic instruction when there is nothing to say.
 */
export function proseBriefFromNote(feedback: string, threads: AnnotationThread[]): string {
  const parts: string[] = [];
  const trimmedFeedback = feedback.trim();
  if (trimmedFeedback.length > 0) {
    parts.push(trimmedFeedback);
  }

  for (const thread of threads) {
    const replies = (thread.replies ?? [])
      .map((reply) => `${reply.author.name}: ${reply.comment}`)
      .join(" ");
    parts.push(replies.length > 0 ? `${thread.comment} Replies: ${replies}` : thread.comment);
  }

  return parts.length > 0 ? parts.join("\n\n") : "Refine the plan.";
}
