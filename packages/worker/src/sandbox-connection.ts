import { isTerminalState, type SessionState } from "@codevil/shared";

export const SANDBOX_RECONNECT_GRACE_MS = 60_000;

export type SandboxConnectionMode = "initialize" | "resume" | "reject";

export function sandboxConnectionMode(
  state: SessionState,
  disconnectedAt: string | undefined,
  attachedSandboxCount = 1,
): SandboxConnectionMode {
  if (state === "provisioning_sandbox") return "initialize";
  if (!isTerminalState(state) && disconnectedAt) return "resume";
  if (
    attachedSandboxCount === 0
    && state !== "initializing"
    && !isTerminalState(state)
  ) return "resume";
  return "reject";
}

export function sandboxReconnectExpired(disconnectedAt: string, now: number): boolean {
  return now >= Date.parse(disconnectedAt) + SANDBOX_RECONNECT_GRACE_MS;
}

export function sandboxReconnectDeadline(disconnectedAt: string): number {
  return Date.parse(disconnectedAt) + SANDBOX_RECONNECT_GRACE_MS;
}

/**
 * A reconnect restores the transport, but it does not prove that cloning has
 * completed. Repository readiness remains owned by the clone_complete event.
 */
export function sandboxReconnectDirectoryState(state: SessionState): "cloning" | "ready" {
  return state === "cloning_repo" ? "cloning" : "ready";
}

export interface SandboxReconnectHost {
  meta: {
    state: SessionState;
    sandbox_disconnected_at?: string;
  } | null;
  saveMeta(): void;
  appendAndBroadcast(event: { type: "status"; message: string }): void;
  updateDirectory(patch: { sandbox_state: "cloning" | "ready" }): void;
}

/** Apply the durable reconnect side effects without claiming a clone completed. */
export function completeSandboxReconnect(host: SandboxReconnectHost): void {
  if (!host.meta) return;
  host.meta.sandbox_disconnected_at = undefined;
  host.saveMeta();
  host.appendAndBroadcast({ type: "status", message: "Sandbox reconnected." });
  host.updateDirectory({ sandbox_state: sandboxReconnectDirectoryState(host.meta.state) });
}
