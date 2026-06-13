/**
 * Utilities for deriving stable block identifiers from hast node positions.
 * Kept in a separate module so it can be tested without pulling in React or
 * browser-only dependencies.
 */

interface HastPoint {
  line: number;
  column: number;
  offset?: number | undefined;
}

interface HastPosition {
  start: HastPoint;
  end: HastPoint;
}

export interface HastNodeWithPosition {
  position?: HastPosition | undefined;
}

/**
 * Derive a stable, deterministic block identifier from a hast-like node.
 *
 * Strategy (in order of preference):
 *  1. If the position carries character `offset` values, use
 *     `block-{start.offset}-{end.offset}`.  This is unique for every
 *     distinct source span even when two nodes share the same start line
 *     (e.g. a loose-list `li` and its child `p`).
 *  2. Otherwise fall back to `block-{sl}:{sc}-{el}:{ec}` using line +
 *     column, which is still unique per source span.
 *  3. Returns null when position data is absent (generated / synthetic
 *     nodes) — callers must handle null gracefully.
 *
 * Determinism: the id is derived solely from the frozen source span, so
 * the same markdown always produces the same ids on every client.
 */
export function blockIdForNode(node: HastNodeWithPosition): string | null {
  if (!node.position) return null;
  const { start, end } = node.position;
  if (start.offset !== undefined && end.offset !== undefined) {
    return `block-${start.offset}-${end.offset}`;
  }
  return `block-${start.line}:${start.column}-${end.line}:${end.column}`;
}
