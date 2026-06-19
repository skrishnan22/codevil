/**
 * Pure helper for sending snapshot frames to WebSocket clients.
 *
 * Extracted from Orchestrator.fetch() so it can be imported and tested
 * in Node.js without pulling in the `cloudflare:workers` DurableObject runtime.
 */

/**
 * Sends a snapshot frame to `send` when the joining client's cursor is behind
 * the DO's snapshotCursor, then returns the cursor to use for tail replay.
 *
 * @param send           Callable that transmits a JSON string to the client.
 * @param joinCursor     The cursor value the joining client supplied in the URL.
 * @param snapshotCursor The DO's current snapshotCursor (0 for fresh sessions).
 * @param snapshot       The DO's current in-memory state (typed as unknown to
 *                       avoid pulling SessionSnapshot into the module signature;
 *                       callers are responsible for passing a valid snapshot).
 * @param path           The event-log path label (defaults to "session").
 * @returns The cursor from which tail replay should start.
 */
export function sendSnapshotIfBehind(
  send: (data: string) => void,
  joinCursor: number,
  snapshotCursor: number,
  snapshot: unknown,
  path = "session",
): number {
  if (joinCursor >= snapshotCursor) return joinCursor;
  send(JSON.stringify({
    type: "snapshot",
    path,
    cursor: snapshotCursor,
    state: snapshot,
  }));
  return snapshotCursor;
}
