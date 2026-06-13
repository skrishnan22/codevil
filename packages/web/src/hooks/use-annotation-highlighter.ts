/**
 * useAnnotationHighlighter
 *
 * Attaches a @plannotator/web-highlighter to the plan-revision container.
 * Fires `onPendingSelection` when the user makes a text selection, passing
 * back a partial anchor and the pending highlight id so the caller can show
 * a composer and either commit or cancel.
 *
 * Also reconciles stored `annotations`:
 *  - "open" annotations are restored via `fromStore`; if the DOM range can't
 *    be located by the highlighter (getDoms returns empty), a quote-search
 *    fallback wraps the anchor text in a `<mark>` scoped to the block element.
 *  - "withdrawn" / "consumed" annotations (or threads removed from the list)
 *    have their highlights removed.
 *  - Clicking a highlight calls `onSelectAnnotation(id)`.
 *
 * Rules:
 *  - Only instantiated when `planRevision` is non-null and NOT locked.
 *  - Disposed and recreated whenever run_id or round changes (fresh revision).
 *  - Does NOT open the composer for store restores (from-store creates).
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
import type { AnnotationAnchor, AnnotationThread } from "@codevil/shared";
import type { PlanRevisionState } from "../stores/session-store";
// Type-only imports — erased at runtime, so the module (which accesses `window`
// at evaluation time) is NOT loaded here.  The actual runtime load happens via
// dynamic import() inside the useEffect below.
import type Highlighter from "@plannotator/web-highlighter";
import type { DomMeta, CreateFrom, EventType } from "@plannotator/web-highlighter/dist/types/index";
import type HighlightSource from "@plannotator/web-highlighter/dist/model/source/index";

export interface PendingSelection {
  highlightId: string;
  anchor: AnnotationAnchor;
}

interface UseAnnotationHighlighterOptions {
  rootRef: React.RefObject<HTMLDivElement | null>;
  planRevision: PlanRevisionState | null;
  onPendingSelection: (pending: PendingSelection) => void;
  annotations: AnnotationThread[];
  onSelectAnnotation: (id: string | null) => void;
}

export interface UseAnnotationHighlighterReturn {
  /** Remove a pending highlight by id (no-op if the highlighter is gone). */
  removeHighlight: (id: string) => void;
}

/**
 * findTextInElement
 *
 * Pure helper: given an element's text content and an anchor text, returns the
 * start character offset of the first occurrence of `needle` within the
 * element's `textContent`, or -1 if not found.
 *
 * Exported so it can be unit-tested in a node environment without DOM.
 */
export function findTextOffset(haystack: string, needle: string): number {
  if (!needle) return -1;
  return haystack.indexOf(needle);
}

/**
 * applyFallbackMark
 *
 * DOM-level helper: finds `text` inside `blockEl`'s text nodes and wraps the
 * first occurrence in a `<mark class="annotation-highlight" data-bind-id="<id>">`.
 * Returns true if the mark was applied, false if the text couldn't be located.
 *
 * This is intentionally thin untested glue (it manipulates the live DOM).
 */
function applyFallbackMark(blockEl: HTMLElement, text: string, id: string): boolean {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const content = node.textContent ?? "";
    const offset = findTextOffset(content, text);
    if (offset === -1) continue;

    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + text.length);

    const mark = document.createElement("mark");
    mark.className = "annotation-highlight";
    mark.dataset.bindId = id;

    try {
      range.surroundContents(mark);
      return true;
    } catch {
      // Range crosses node boundaries — can't surround, give up.
      return false;
    }
  }

  return false;
}

/**
 * removeFallbackMark
 *
 * Removes a manually-applied fallback mark by `data-bind-id` within rootEl,
 * unwrapping its children back into the parent.
 */
function removeFallbackMark(rootEl: HTMLElement, id: string): void {
  const mark = rootEl.querySelector<HTMLElement>(`mark[data-bind-id="${id}"]`);
  if (!mark) return;
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
}

export function useAnnotationHighlighter({
  rootRef,
  planRevision,
  onPendingSelection,
  annotations,
  onSelectAnnotation,
}: UseAnnotationHighlighterOptions): UseAnnotationHighlighterReturn {
  // Stable ref so the event callback always sees the latest version.
  const onPendingSelectionRef = useRef(onPendingSelection);
  useEffect(() => {
    onPendingSelectionRef.current = onPendingSelection;
  });

  const onSelectAnnotationRef = useRef(onSelectAnnotation);
  useEffect(() => {
    onSelectAnnotationRef.current = onSelectAnnotation;
  });

  // Key the highlighter to run_id+round so a new revision always gets a fresh
  // instance.  Skip when locked (revision is read-only).
  const runId = planRevision?.runId ?? null;
  const round = planRevision?.round ?? null;
  const locked = planRevision?.locked ?? false;

  // Ref to the live highlighter instance so removeHighlight can reach it.
  const highlighterRef = useRef<Highlighter | null>(null);

  // Track which annotation ids have been applied as highlights (for reconciliation).
  const appliedIdsRef = useRef<Set<string>>(new Set());

  // Ref to the latest annotations so the reconcile function always sees the
  // current list without being stale-captured in the async import callback.
  const annotationsRef = useRef<AnnotationThread[]>(annotations);
  useEffect(() => {
    annotationsRef.current = annotations;
  });

  // reconcileRef holds the latest reconcile function so it can be called both
  // from within the async init (first reconcile) and from the annotations-change
  // effect (subsequent reconciles).
  const reconcileRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    // Don't instantiate when there is no mounted root, no current revision, or
    // when the revision is locked (read-only).
    if (!root || !runId || round === null || locked) return;

    let disposed = false;
    let hInstance: Highlighter | null = null;
    // Handler and event name stored here so the cleanup closure can call off().
    let attachedCreateHandler: ((data: { sources: HighlightSource[]; type: CreateFrom }, h: Highlighter) => void) | null = null;
    let attachedClickHandler: ((data: { id: string }, h: Highlighter, e: MouseEvent | TouchEvent) => void) | null = null;
    let createEventName: EventType | null = null;
    let clickEventName: EventType | null = null;

    // Reset the applied-ids tracking for this new highlighter instance.
    appliedIdsRef.current = new Set();

    // Note: CreateFrom is defined in the types sub-path but is not re-exported
    // from the package root.  Values are inlined here, verified against the
    // dist/types/index.d.ts enum declaration (`STORE = "from-store"`).
    const CreateFrom = { STORE: "from-store" as CreateFrom, INPUT: "from-input" as CreateFrom } as const;
    import("@plannotator/web-highlighter").then(({ default: HighlighterClass }) => {
      if (disposed) return;

      const h = new HighlighterClass({
        $root: root,
        wrapTag: "mark",
        style: { className: "annotation-highlight" },
      });

      hInstance = h;
      highlighterRef.current = h;
      h.run();

      const CREATE_EVENT = HighlighterClass.event.CREATE;
      const CLICK_EVENT = HighlighterClass.event.CLICK;
      createEventName = CREATE_EVENT;
      clickEventName = CLICK_EVENT;

      // Define the reconcile function and store it in the ref so the
      // annotations-change effect can call it too.
      const reconcile = () => {
        if (!highlighterRef.current) return;
        const hl = highlighterRef.current;
        const currentAnnotations = annotationsRef.current;
        const applied = appliedIdsRef.current;

        // --- Apply open annotations that haven't been applied yet ---
        for (const thread of currentAnnotations) {
          if (thread.status !== "open") continue;
          if (applied.has(thread.id)) continue;

          const { anchor } = thread;
          hl.fromStore(
            anchor.startMeta as DomMeta,
            anchor.endMeta as DomMeta,
            anchor.text,
            thread.id,
          );

          const doms = hl.getDoms(thread.id);
          if (doms.length > 0) {
            applied.add(thread.id);
          } else {
            // Restore failed — try quote-search fallback in the block element.
            const blockEl = root.querySelector<HTMLElement>(
              `[data-block-id="${anchor.blockId}"]`,
            );
            if (blockEl && applyFallbackMark(blockEl, anchor.text, thread.id)) {
              applied.add(thread.id);
            }
            // If fallback also fails, leave the id out of applied so we retry
            // on the next reconcile (e.g. after a re-render completes).
          }
        }

        // --- Remove highlights for threads that are no longer open ---
        const openIds = new Set(
          currentAnnotations
            .filter((t) => t.status === "open")
            .map((t) => t.id),
        );

        for (const id of [...applied]) {
          if (!openIds.has(id)) {
            hl.remove(id);
            removeFallbackMark(root, id);
            applied.delete(id);
          }
        }
      };

      reconcileRef.current = reconcile;

      // CreateFrom.STORE ("from-store") covers restores from persisted data;
      // CreateFrom.INPUT ("from-input") is a live user selection — the only
      // case we act on.
      const createHandler = (data: { sources: HighlightSource[]; type: CreateFrom }) => {
        const { sources, type } = data;

        if (type === CreateFrom.STORE) return;
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

      const clickHandler = (data: { id: string }) => {
        onSelectAnnotationRef.current(data.id);
      };

      attachedCreateHandler = createHandler;
      attachedClickHandler = clickHandler;
      h.on(CREATE_EVENT, createHandler);
      h.on(CLICK_EVENT, clickHandler);

      // Run the first reconcile now that the highlighter is ready.
      reconcile();
    });

    return () => {
      disposed = true;
      reconcileRef.current = null;
      if (hInstance) {
        if (attachedCreateHandler && createEventName) {
          hInstance.off(createEventName, attachedCreateHandler);
        }
        if (attachedClickHandler && clickEventName) {
          hInstance.off(clickEventName, attachedClickHandler);
        }
      }
      hInstance?.dispose();
      hInstance = null;
      highlighterRef.current = null;
      appliedIdsRef.current = new Set();
    };
  // Recreate when revision identity or locked status changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef, runId, round, locked]);

  // Re-reconcile whenever annotations change (and the highlighter is already
  // ready).  The reconcile function is a no-op if the highlighter isn't live.
  useEffect(() => {
    reconcileRef.current?.();
  }, [annotations]);

  const removeHighlight = useCallback((id: string) => {
    highlighterRef.current?.remove(id);
  }, []);

  return { removeHighlight };
}
