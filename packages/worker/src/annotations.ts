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
