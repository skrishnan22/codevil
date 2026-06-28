import type { ZodIssue } from "zod";

import type { DOToCLIEvent } from "./messages-cli.js";
import {
  DOToCLIEventSchema,
  PersistedDOToCLIEventSchema,
} from "./messages-cli.js";
import type { SessionSnapshot } from "./projections.js";
import { SessionSnapshotSchema } from "./session-snapshot-schema.js";
import { parseInbound } from "./validation.js";

export interface ParseFailure {
  kind: "parse_failure";
  boundary: "persisted_replay" | "session_snapshot";
  issues: ZodIssue[];
}

type ParseFailureSink = (failure: ParseFailure) => void;

let failureSink: ParseFailureSink = (failure) => {
  try {
    console.error(JSON.stringify(failure));
  } catch {
    console.error("[parse_failure]", failure.boundary);
  }
};

export function setParseFailureSink(next: ParseFailureSink): void {
  failureSink = next;
}

/**
 * Parse a persisted or replayed DO→CLI event.
 * Strict `DOToCLIEventSchema` first; lenient passthrough for legacy log rows.
 */
export function parseReplayEvent(raw: unknown): DOToCLIEvent | null {
  const strict = DOToCLIEventSchema.safeParse(raw);
  if (strict.success) return strict.data;

  const lenient = parseInbound(PersistedDOToCLIEventSchema, raw, "persisted_replay");
  if (!lenient) return null;

  return lenient as DOToCLIEvent;
}

/** Validate a hydrated or wire snapshot blob. */
export function parseSessionSnapshot(raw: unknown): SessionSnapshot | null {
  const result = SessionSnapshotSchema.safeParse(raw);
  if (result.success) return result.data;

  failureSink({
    kind: "parse_failure",
    boundary: "session_snapshot",
    issues: result.error.issues,
  });
  return null;
}
