/**
 * Pure gating predicates for annotation thread actions.
 * No side-effects — safe to unit-test in node without jsdom.
 */

import type { AnnotationThread } from "@codevil/shared";

/**
 * Returns true when the current user may withdraw the given thread:
 *  - they are the thread's author
 *  - the thread is still open (not withdrawn or consumed)
 *  - the plan revision is not locked
 */
export function canWithdraw(
  thread: AnnotationThread,
  currentUserId: string | null,
  locked: boolean,
): boolean {
  if (!currentUserId) return false;
  if (thread.author.id !== currentUserId) return false;
  if (thread.status !== "open") return false;
  if (locked) return false;
  return true;
}

/**
 * Returns true when anyone may reply to an annotation thread:
 *  - the plan revision is not locked
 */
export function canReply(locked: boolean): boolean {
  return !locked;
}

/**
 * Sort comparator for annotation threads: ascending by sourceLine, then by
 * created_at ISO string (lexicographic, which equals chronological for ISO 8601).
 */
export function compareThreads(a: AnnotationThread, b: AnnotationThread): number {
  const lineDiff = a.anchor.sourceLine - b.anchor.sourceLine;
  if (lineDiff !== 0) return lineDiff;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/**
 * Returns the open threads for the given run_id/round, sorted for display.
 */
export function openThreadsSorted(
  threads: AnnotationThread[],
  runId: string,
  round: number,
): AnnotationThread[] {
  return threads
    .filter((t) => t.run_id === runId && t.round === round && t.status === "open")
    .sort(compareThreads);
}
