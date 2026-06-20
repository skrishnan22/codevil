import { isTerminalState, type SessionState } from "@codevil/shared";

export const SANDBOX_RECONNECT_GRACE_MS = 60_000;

export type SandboxConnectionMode = "initialize" | "resume" | "reject";

export function sandboxConnectionMode(
  state: SessionState,
  disconnectedAt: string | undefined,
): SandboxConnectionMode {
  if (state === "provisioning_sandbox") return "initialize";
  if (!isTerminalState(state) && disconnectedAt) return "resume";
  return "reject";
}

export function sandboxReconnectExpired(disconnectedAt: string, now: number): boolean {
  return now >= Date.parse(disconnectedAt) + SANDBOX_RECONNECT_GRACE_MS;
}

export function sandboxReconnectDeadline(disconnectedAt: string): number {
  return Date.parse(disconnectedAt) + SANDBOX_RECONNECT_GRACE_MS;
}
