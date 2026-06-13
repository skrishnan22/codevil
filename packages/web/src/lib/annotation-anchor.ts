/**
 * Pure helper: build an AnnotationAnchor from a web-highlighter source and a
 * block element-like object.  Kept free of DOM / React so it can be unit-tested
 * in the node (vitest) environment without jsdom.
 *
 * @param source   - shape produced by the web-highlighter CREATE event:
 *                   { startMeta, endMeta, text }
 * @param blockEl  - element or stub exposing `dataset.blockId` and
 *                   `dataset.sourceLine`
 *
 * @returns  A valid AnnotationAnchor, or null when blockId / sourceLine are
 *           absent or sourceLine is not a positive integer.
 */

import type { AnnotationAnchor, DomMeta } from "@codevil/shared";

export interface HighlighterSourceLike {
  startMeta: DomMeta;
  endMeta: DomMeta;
  text: string;
}

export interface BlockElementLike {
  dataset: {
    blockId?: string;
    sourceLine?: string;
  };
}

export function buildAnnotationAnchor(
  source: HighlighterSourceLike,
  blockEl: BlockElementLike,
): AnnotationAnchor | null {
  const blockId = blockEl.dataset.blockId;
  const rawLine = blockEl.dataset.sourceLine;

  if (!blockId || blockId.length === 0) return null;
  if (!rawLine) return null;

  const sourceLine = parseInt(rawLine, 10);
  if (!Number.isInteger(sourceLine) || sourceLine <= 0) return null;

  return {
    startMeta: source.startMeta,
    endMeta: source.endMeta,
    text: source.text,
    blockId,
    sourceLine,
  };
}
