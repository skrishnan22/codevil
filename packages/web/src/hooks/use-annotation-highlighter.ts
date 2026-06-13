/**
 * useAnnotationHighlighter
 *
 * Attaches a @plannotator/web-highlighter to the plan-revision container.
 * Fires `onPendingSelection` when the user makes a text selection, passing
 * back a partial anchor and the pending highlight id so the caller can show
 * a composer and either commit or cancel.
 *
 * Rules:
 *  - Only instantiated when `planRevision` is non-null and NOT locked.
 *  - Disposed and recreated whenever run_id or round changes (fresh revision).
 *  - Does NOT render existing/remote annotations — that is Task 4.
 *
 * Returns a `removeHighlight(id)` function that is valid as long as the
 * current highlighter instance is alive.  Callers (e.g. the cancel path)
 * should use it to clean up a pending `<mark>` when the composer is dismissed.
 *
 * Implementation note: @plannotator/web-highlighter accesses `window` at
 * module-evaluation time, which breaks Node.js test environments.  We use a
 * dynamic import inside the useEffect so the module is only loaded inside a
 * browser context.
 */

import { useCallback, useEffect, useRef } from "react";
import { buildAnnotationAnchor } from "../lib/annotation-anchor";
import type { AnnotationAnchor, DomMeta } from "@codevil/shared";
import type { PlanRevisionState } from "../stores/session-store";

export interface PendingSelection {
  highlightId: string;
  anchor: AnnotationAnchor;
}

interface UseAnnotationHighlighterOptions {
  rootRef: React.RefObject<HTMLDivElement | null>;
  planRevision: PlanRevisionState | null;
  onPendingSelection: (pending: PendingSelection) => void;
}

export interface UseAnnotationHighlighterReturn {
  /** Remove a pending highlight by id (no-op if the highlighter is gone). */
  removeHighlight: (id: string) => void;
}

// Minimal shape we need from a live Highlighter instance.
interface HighlighterInstance {
  run: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  off: (event: string, handler: (...args: unknown[]) => void) => unknown;
  getDoms: (id: string) => HTMLElement[];
  remove: (id: string) => void;
  dispose: () => void;
}

export function useAnnotationHighlighter({
  rootRef,
  planRevision,
  onPendingSelection,
}: UseAnnotationHighlighterOptions): UseAnnotationHighlighterReturn {
  // Stable ref so the event callback always sees the latest version.
  const onPendingSelectionRef = useRef(onPendingSelection);
  useEffect(() => {
    onPendingSelectionRef.current = onPendingSelection;
  });

  // Key the highlighter to run_id+round so a new revision always gets a fresh
  // instance.  Skip when locked (revision is read-only).
  const runId = planRevision?.runId ?? null;
  const round = planRevision?.round ?? null;
  const locked = planRevision?.locked ?? false;

  // Ref to the live highlighter instance so removeHighlight can reach it.
  const highlighterRef = useRef<HighlighterInstance | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    // Don't instantiate when there is no mounted root, no current revision, or
    // when the revision is locked (read-only).
    if (!root || !runId || round === null || locked) return;

    let disposed = false;
    let hInstance: HighlighterInstance | null = null;
    // Handler stored here so we can call off() during cleanup.
    let attachedHandler: ((...args: unknown[]) => void) | null = null;
    const CREATE_EVENT = "selection:create";

    // Dynamic import keeps the module out of the node.js module graph during
    // test execution (it accesses window at evaluation time).
    import("@plannotator/web-highlighter").then(({ default: Highlighter }) => {
      if (disposed) return;

      const h = new Highlighter({
        $root: root,
        wrapTag: "mark",
        style: { className: "annotation-highlight" },
      }) as unknown as HighlighterInstance;

      hInstance = h;
      highlighterRef.current = h;
      h.run();

      // CreateFrom enum: "from-store" for restores, "from-input" for user
      // selections.  We only care about user-initiated selections.
      const handler = (...args: unknown[]) => {
        const data = args[0] as {
          sources: { id: string; startMeta: DomMeta; endMeta: DomMeta; text: string }[];
          type: string;
        };
        const { sources, type } = data;

        if (type === "from-store") return;
        if (!sources.length) return;

        const source = sources[0];
        const doms = h.getDoms(source.id);
        if (!doms.length) {
          h.remove(source.id);
          return;
        }

        const blockEl = doms[0].closest("[data-block-id]") as HTMLElement | null;
        if (!blockEl) {
          h.remove(source.id);
          return;
        }

        const anchor = buildAnnotationAnchor(
          { startMeta: source.startMeta, endMeta: source.endMeta, text: source.text },
          {
            dataset: {
              blockId: blockEl.dataset.blockId,
              sourceLine: blockEl.dataset.sourceLine,
            },
          },
        );

        if (!anchor) {
          h.remove(source.id);
          return;
        }

        onPendingSelectionRef.current({ highlightId: source.id, anchor });
      };

      attachedHandler = handler;
      h.on(CREATE_EVENT, handler);
    });

    return () => {
      disposed = true;
      if (hInstance && attachedHandler) {
        hInstance.off(CREATE_EVENT, attachedHandler);
      }
      hInstance?.dispose();
      hInstance = null;
      highlighterRef.current = null;
    };
  // Recreate when revision identity or locked status changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef, runId, round, locked]);

  const removeHighlight = useCallback((id: string) => {
    highlighterRef.current?.remove(id);
  }, []);

  return { removeHighlight };
}
