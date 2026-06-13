// Pure helpers for multiplayer attribution. Kept free of Durable Object state
// so they can be unit-tested without the workerd runtime.

const MAX_NAME_LENGTH = 64;
const ANONYMOUS = "Anonymous";
const PARTICIPANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Non-whitespace control characters (C0 controls except tab/newline/CR, plus
// DEL). These are deleted outright; tab/newline/CR are handled by whitespace
// collapsing so that "Alice\nSmith" becomes "Alice Smith", not "AliceSmith".
const NON_WHITESPACE_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize a self-declared display name before it is stored or broadcast.
 * Data hygiene only — names remain spoofable by anyone holding the shared key.
 */
export function sanitizeDisplayName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return ANONYMOUS;

  const cleaned = raw
    .replace(NON_WHITESPACE_CONTROL, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trimEnd();

  return cleaned.length > 0 ? cleaned : ANONYMOUS;
}

export function sanitizeParticipantId(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "usr_anonymous";
  const trimmed = raw.trim();
  return PARTICIPANT_ID_PATTERN.test(trimmed) ? trimmed : "usr_anonymous";
}

export interface LastDecision {
  actor: string;
  action: "approve" | "refine";
  refinement_round: number;
}

/**
 * Build a friendly, attributed rejection message when a plan decision
 * (approve/refine) arrives too late because someone already decided.
 *
 * Returns null — meaning "fall back to the generic state-only message" — unless
 * a decision was recorded for the *current* refinement round. Keying on the
 * round prevents naming someone who acted on a previous plan.
 */
export function describeDecisionRejection(
  _attemptedAction: "approve" | "refine",
  lastDecision: LastDecision | null,
  currentRound: number,
): { actor: string; message: string } | null {
  if (!lastDecision) return null;
  if (lastDecision.refinement_round !== currentRound) return null;

  const message =
    lastDecision.action === "approve"
      ? `${lastDecision.actor} already approved this plan.`
      : `${lastDecision.actor} already sent this plan back for refinement.`;

  return { actor: lastDecision.actor, message };
}
