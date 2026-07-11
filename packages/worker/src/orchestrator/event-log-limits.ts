import type { DOToCLIEvent } from "@codevil/shared";

export const EVENT_LOG_RETENTION_DAYS = 7;
export const MAX_EVENT_JSON_BYTES = 64 * 1024;

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
