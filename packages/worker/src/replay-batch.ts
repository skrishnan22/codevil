/**
 * Pure helper for building and sending replay_batch frames to WebSocket clients.
 *
 * Extracted from Orchestrator.replayEvents() so it can be imported and tested
 * in Node.js without pulling in the `cloudflare:workers` DurableObject runtime.
 */

import { parseReplayEvent } from "@codevil/shared";
import type { DOToCLIEvent } from "@codevil/shared";

export interface ReplayRow {
  id: number;
  event_json: string;
}

/**
 * Builds the events array for a replay_batch frame from raw DB rows.
 *
 * Each parsed event is validated with `parseReplayEvent` (strict first, lenient
 * fallback for legacy rows). Unparseable JSON or invalid events are skipped.
 */
export function buildReplayBatch(
  rows: Iterable<ReplayRow>,
): Array<{ cursor: number; event: DOToCLIEvent }> {
  const events: Array<{ cursor: number; event: DOToCLIEvent }> = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.event_json);
    } catch {
      continue;
    }

    const event = parseReplayEvent(raw);
    if (event) {
      events.push({ cursor: row.id, event });
    }
  }
  return events;
}
