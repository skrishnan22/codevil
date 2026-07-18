import { isTerminalState, type SessionState } from "@codevil/shared";

export const SANDBOX_RECONNECT_GRACE_MS = 60_000;

export type SandboxConnectionMode = "initialize" | "resume" | "reject";

const ORPHAN_RECONNECT_STATES: ReadonlySet<SessionState> = new Set([
  "planning",
  "awaiting_approval",
  "refining",
  "executing",
  "verifying",
  "retrying",
  "creating_pr",
]);

export function sandboxConnectionMode(
  state: SessionState,
  disconnectedAt: string | undefined,
  attachedSandboxCount = 1,
): SandboxConnectionMode {
  if (state === "provisioning_sandbox") return "initialize";
  if (!isTerminalState(state) && disconnectedAt) return "resume";
  if (attachedSandboxCount === 0 && ORPHAN_RECONNECT_STATES.has(state)) return "resume";
  return "reject";
}

export function sandboxReconnectExpired(disconnectedAt: string, now: number): boolean {
  return now >= Date.parse(disconnectedAt) + SANDBOX_RECONNECT_GRACE_MS;
}

export function sandboxReconnectDeadline(disconnectedAt: string): number {
  return Date.parse(disconnectedAt) + SANDBOX_RECONNECT_GRACE_MS;
}
