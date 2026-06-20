/**
 * Pure helper for building and sending replay_batch frames to WebSocket clients.
 *
 * Extracted from Orchestrator.replayEvents() so it can be imported and tested
 * in Node.js without pulling in the `cloudflare:workers` DurableObject runtime.
 */

export interface ReplayRow {
  id: number;
  event_json: string;
}

/**
 * Builds the events array for a replay_batch frame from raw DB rows.
 *
 * Schema re-validation is intentionally skipped: rows were validated when
 * written to the events table, so we trust the stored bytes on replay.
 *
 * Rows with unparseable JSON are silently skipped to avoid killing the batch.
 */
export function buildReplayBatch(
  rows: Iterable<ReplayRow>,
): Array<{ cursor: number; event: unknown }> {
  const events: Array<{ cursor: number; event: unknown }> = [];
  for (const row of rows) {
    try {
      events.push({ cursor: row.id, event: JSON.parse(row.event_json) });
    } catch {
      // skip unparseable row — don't kill the batch
    }
  }
  return events;
}
