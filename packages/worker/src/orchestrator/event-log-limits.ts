import type { DOToCLIEvent, SessionSnapshot } from "@codevil/shared";

export const EVENT_LOG_RETENTION_DAYS = 7;
export const MAX_EVENT_JSON_BYTES = 64 * 1024;
/**
 * Snapshots are sent wholesale to reconnecting clients, so keep their
 * presentation-only history below a size that is cheap to persist and replay.
 * Structural session fields are deliberately never evicted here.
 */
export const MAX_SESSION_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_SESSION_MESSAGES = 500;
export const MAX_SESSION_ACTIVITY_ENTRIES = 1_000;
export const MAX_PREVIEW_OUTPUT_LINE_CHARS = 4 * 1024;
/** Prevent a busy session from accumulating an unbounded un-snapshotted tail. */
export const MAX_EVENTS_BETWEEN_SNAPSHOTS = 1_000;

export interface PreparedSnapshotCheckpoint {
  snapshot: SessionSnapshot;
  canPersist: boolean;
}

export function shouldCompactEventTail(eventCount: number): boolean {
  return eventCount >= MAX_EVENTS_BETWEEN_SNAPSHOTS;
}

export function eventJsonByteLength(json: string): number {
  return new TextEncoder().encode(json).length;
}

/** Shrink string fields until serialized event fits within maxBytes. */
export function capEventForStorage(
  event: DOToCLIEvent,
  maxBytes = MAX_EVENT_JSON_BYTES,
): { event: DOToCLIEvent; truncated: boolean } {
  let json = JSON.stringify(event);
  if (eventJsonByteLength(json) <= maxBytes) {
    return { event, truncated: false };
  }

  const working = structuredClone(event) as Record<string, unknown>;
  let truncated = false;

  for (let pass = 0; pass < 32; pass++) {
    json = JSON.stringify(working);
    if (eventJsonByteLength(json) <= maxBytes) {
      return { event: working as DOToCLIEvent, truncated };
    }

    const longest = findLongestStringPath(working);
    if (!longest) break;

    const current = readPath(working, longest.path);
    if (typeof current !== "string" || current.length === 0) break;

    const nextLength = Math.max(0, Math.floor(current.length * 0.5));
    const suffix = nextLength < current.length ? "… [truncated]" : "";
    writePath(working, longest.path, current.slice(0, nextLength) + suffix);
    truncated = true;
  }

  return {
    event: {
      type: "status",
      message: `Event ${event.type} omitted: payload exceeded ${maxBytes} bytes after truncation`,
    },
    truncated: true,
  };
}

/**
 * Bounds only derived, non-protocol display history.  The durable snapshot is
 * the authoritative cursor checkpoint, so its session state (phase, plan,
 * participants, questions, annotations, and preview state) must remain exact.
 * Messages and activity are historical UI projections and can be evicted from
 * oldest to newest without changing protocol behaviour or cursor semantics.
 */
export function capSessionSnapshotForStorage(snapshot: SessionSnapshot): SessionSnapshot {
  let messages = snapshot.messages.slice(-MAX_SESSION_MESSAGES);
  let activityLog = snapshot.activityLog.slice(-MAX_SESSION_ACTIVITY_ENTRIES);
  const preview = {
    ...snapshot.preview,
    outputLines: snapshot.preview.outputLines.map((line) =>
      line.length <= MAX_PREVIEW_OUTPUT_LINE_CHARS
        ? line
        : `${line.slice(0, MAX_PREVIEW_OUTPUT_LINE_CHARS)}… [truncated]`,
    ),
  };

  const build = (): SessionSnapshot => ({ ...snapshot, preview, messages, activityLog });
  let capped = build();

  while (eventJsonByteLength(JSON.stringify(capped)) > MAX_SESSION_SNAPSHOT_BYTES) {
    if (messages.length === 0 && activityLog.length === 0) break;

    const messageTimestamp = messages[0]?.timestamp ?? Number.POSITIVE_INFINITY;
    const activityTimestamp = activityLog[0]?.timestamp ?? Number.POSITIVE_INFINITY;
    if (messageTimestamp <= activityTimestamp) {
      messages = messages.slice(1);
    } else {
      activityLog = activityLog.slice(1);
    }
    capped = build();
  }

  return capped;
}

/**
 * Prepare a display-bounded checkpoint without ever truncating structural
 * session data. A structural field that still exceeds the storage budget
 * leaves the previous durable checkpoint and its event tail authoritative.
 */
export function prepareSnapshotCheckpoint(snapshot: SessionSnapshot): PreparedSnapshotCheckpoint {
  const capped = capSessionSnapshotForStorage(snapshot);
  return {
    snapshot: capped,
    canPersist: eventJsonByteLength(JSON.stringify(capped)) <= MAX_SESSION_SNAPSHOT_BYTES,
  };
}

function findLongestStringPath(
  value: unknown,
  path: string[] = [],
): { path: string[]; length: number } | undefined {
  if (typeof value === "string") {
    return { path, length: value.length };
  }

  if (Array.isArray(value)) {
    let longest: { path: string[]; length: number } | undefined;
    for (let index = 0; index < value.length; index++) {
      const candidate = findLongestStringPath(value[index], [...path, String(index)]);
      if (candidate && (!longest || candidate.length > longest.length)) {
        longest = candidate;
      }
    }
    return longest;
  }

  if (value && typeof value === "object") {
    let longest: { path: string[]; length: number } | undefined;
    for (const [key, nested] of Object.entries(value)) {
      const candidate = findLongestStringPath(nested, [...path, key]);
      if (candidate && (!longest || candidate.length > longest.length)) {
        longest = candidate;
      }
    }
    return longest;
  }

  return undefined;
}

function readPath(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function writePath(value: Record<string, unknown>, path: string[], next: string): void {
  let current: unknown = value;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index];
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  const last = path.at(-1);
  if (last === undefined) return;

  if (Array.isArray(current)) {
    current[Number(last)] = next;
    return;
  }
  if (current && typeof current === "object") {
    (current as Record<string, unknown>)[last] = next;
  }
}
