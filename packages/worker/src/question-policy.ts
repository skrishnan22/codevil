// Pure helpers for question answering policy. Kept free of Durable Object state
// so they can be unit-tested without the workerd runtime.

import type { AnswerableBy } from "@codevil/shared";

/**
 * Returns true if the user identified by `userId` holds a "decider" role for
 * the session.
 *
 * - If the session has a known creator (`creatorId` is non-null and non-empty),
 *   the decider is exactly that user.
 * - If there is no creator on record (anonymous / legacy sessions), membership
 *   role is used as the fallback: owner or admin qualifies.
 * - A missing userId (unauthenticated websocket) always returns false.
 */
export function isDecider(
  userId: string | null,
  creatorId: string | null | undefined,
  role: string | null | undefined,
): boolean {
  if (!userId) return false;
  if (creatorId) return creatorId === userId;
  return role === "owner" || role === "admin";
}

/**
 * Returns true if the user is allowed to answer the question.
 *
 * - `"anyone"` → any authenticated session member may answer
 *   (membership is already enforced upstream by ws-authorization).
 * - `"decider"` → only the session decider (creator / owner / admin)
 *   may answer.
 * - `"assigned"` → only the explicitly assigned participant may answer.
 */
export function canAnswerQuestion(
  answerableBy: AnswerableBy,
  userId: string | null,
  creatorId: string | null | undefined,
  role: string | null | undefined,
  assignedToId?: string | null,
): boolean {
  if (answerableBy === "anyone") return true;
  if (answerableBy === "assigned") {
    return Boolean(userId && assignedToId && userId === assignedToId);
  }
  return isDecider(userId, creatorId, role);
}
