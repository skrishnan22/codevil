import type { SessionState } from "@codevil/shared";

/** How often the orchestrator re-extends a provider sandbox lease (e.g. E2B). */
export const SANDBOX_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;
/** Default time a ready session may sit idle before its sandbox is paused. */
export const DEFAULT_MAX_IDLE_MS = 10 * 60_000;

const MIN_SANDBOX_LEASE_MS = 60_000;

export interface IdlePauseInput {
  now: number;
  pauseSupported: boolean;
  sessionState: SessionState;
  paused: boolean;
  sandboxConnected: boolean;
  disconnectedAt?: string;
  hasActiveRun: boolean;
  queuedRuns: number;
  openQuestions: number;
  lastActivityAt: string;
  maxIdleMs: number | null;
}

export function idlePauseDeadline(
  input: Pick<IdlePauseInput, "lastActivityAt" | "maxIdleMs">,
): number | null {
  if (input.maxIdleMs === null) return null;
  return Date.parse(input.lastActivityAt) + input.maxIdleMs;
}

export function shouldPauseSandbox(input: IdlePauseInput): boolean {
  if (
    !input.pauseSupported ||
    input.paused ||
    input.sessionState !== "ready" ||
    !input.sandboxConnected ||
    input.disconnectedAt ||
    input.hasActiveRun ||
    input.queuedRuns !== 0 ||
    input.openQuestions !== 0
  ) {
    return false;
  }
  const deadline = idlePauseDeadline(input);
  return deadline !== null && input.now >= deadline;
}

export function sandboxLeaseMs(input: {
  now: number;
  createdAt: number;
  maxTimeMs: number | null;
  providerMaxMs: number;
}): number {
  const remainingMs =
    input.maxTimeMs === null
      ? input.providerMaxMs
      : Math.max(MIN_SANDBOX_LEASE_MS, input.createdAt + input.maxTimeMs - input.now);
  return Math.min(input.providerMaxMs, remainingMs);
}

export function leaseRenewDeadline(input: { renewedAt?: string; createdAt: string }): number {
  return Date.parse(input.renewedAt ?? input.createdAt) + SANDBOX_LEASE_RENEW_INTERVAL_MS;
}
