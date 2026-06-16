/**
 * Pure helpers for routing and presenting plan-mode conflict questions.
 *
 * A "conflict question" is the specialization of the generic ask_question
 * payload that the consolidation agent emits when two annotations
 * contradict (see 2026-06-14 spec). We detect it by shape and resolve each
 * option to its underlying annotation so the conflict card can render
 * authors, timestamps, and anchor previews — none of which travel on the
 * question payload itself.
 *
 * No React, no store imports — safe to unit-test in the node vitest env.
 */

import type { AnnotationThread, ParticipantIdentity } from "@codevil/shared";
import type { QuestionViewModel } from "@/stores/session-store";

const ANCHOR_PREVIEW_MAX_CHARS = 40;

/**
 * One side of a binary conflict, resolved against the current annotation set.
 * `missing` is true when the option's id does not match any known annotation
 * (e.g. legacy session, GC'd round). The card still renders using `label` and
 * `detail` from the question payload in that case.
 */
export interface ConflictSide {
  optionId: string;
  label: string;
  detail: string | undefined;
  author: ParticipantIdentity | null;
  createdAt: string | null;
  anchorTextPreview: string | null;
  withdrawn: boolean;
  missing: boolean;
}

/**
 * Returns true when the question is shaped like a binary annotation conflict:
 *   - exactly two options
 *   - single-select
 *   - each option id maps to a known annotation thread id in the current set
 *
 * Falls back to the generic QuestionCard when any check fails.
 */
export function isConflictQuestion(
  q: QuestionViewModel,
  annotations: AnnotationThread[],
): boolean {
  if (!q.options || q.options.length !== 2) return false;
  if (q.allowMultiple) return false;
  const knownIds = new Set(annotations.map((a) => a.id));
  return q.options.every((opt) => knownIds.has(opt.id));
}

/**
 * Resolves a conflict question's two options into `ConflictSide`s using the
 * current annotation set. Returns the two sides in the original option order
 * (which is the order the consolidation agent placed them).
 *
 * Pre-condition: `isConflictQuestion(q, annotations)` was true at some point;
 * we still defensively handle missing annotations here in case one was
 * withdrawn between `isConflictQuestion` and this call.
 */
export function deriveSides(
  q: QuestionViewModel,
  annotations: AnnotationThread[],
): ConflictSide[] {
  if (!q.options) return [];
  const byId = new Map(annotations.map((a) => [a.id, a]));
  return q.options.map((opt) => {
    const a = byId.get(opt.id);
    if (!a) {
      return {
        optionId: opt.id,
        label: opt.label,
        detail: opt.detail,
        author: null,
        createdAt: null,
        anchorTextPreview: null,
        withdrawn: false,
        missing: true,
      };
    }
    return {
      optionId: opt.id,
      label: opt.label,
      detail: opt.detail,
      author: a.author,
      createdAt: a.created_at,
      anchorTextPreview: truncateAnchorText(a.anchor.text),
      withdrawn: a.status !== "open",
      missing: false,
    };
  });
}

/**
 * Sorts questions ascending by `raisedAt` (then by `requestId` as a stable
 * tiebreak when two questions share a timestamp).
 */
export function orderByRaisedAt(
  questions: QuestionViewModel[],
): QuestionViewModel[] {
  return [...questions].sort((a, b) => {
    if (a.raisedAt !== b.raisedAt) return a.raisedAt - b.raisedAt;
    return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
  });
}

/**
 * Returns the open conflict questions in raised-time order. Used by both the
 * Timeline's queue rendering and the chat-input gate.
 */
export function openConflictsInOrder(
  questions: QuestionViewModel[],
  annotations: AnnotationThread[],
): QuestionViewModel[] {
  const open = questions.filter(
    (q) => q.status === "open" && isConflictQuestion(q, annotations),
  );
  return orderByRaisedAt(open);
}

/**
 * Chat-input gate: while a conflict is structurally blocking Pi, lock the
 * conversation input so the decision doesn't scroll away under new chatter.
 * Non-conflict open questions remain advisory and do NOT disable input.
 */
export function shouldDisableChatInput(
  questions: QuestionViewModel[],
  annotations: AnnotationThread[],
): { disabled: boolean; hint?: string } {
  const blocking = openConflictsInOrder(questions, annotations);
  if (blocking.length === 0) return { disabled: false };
  return {
    disabled: true,
    hint: "Resolve the decision above to continue.",
  };
}

function truncateAnchorText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= ANCHOR_PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, ANCHOR_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}
