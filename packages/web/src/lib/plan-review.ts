/**
 * Pure helpers for the plan-review auto-open logic.
 * Kept in a lib module (not the route file) so they can be unit-tested without
 * importing TanStack Router or any React runtime.
 */

/**
 * Returns a stable key string for the current plan revision.
 * Used to detect when a new revision arrives so we can auto-open the review
 * panel exactly once per revision.
 */
export function revisionKey(runId: string, round: number): string {
  return `${runId}:${round}`;
}

/**
 * Pure predicate: should we auto-open the panel for this revision?
 * Returns true when the revision key has changed from the last-seen key.
 */
export function shouldAutoOpen(
  lastSeenKey: string | null,
  currentKey: string | null,
): boolean {
  if (currentKey === null) return false;
  return currentKey !== lastSeenKey;
}
