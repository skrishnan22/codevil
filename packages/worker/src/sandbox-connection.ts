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

/** The slice of a WebSocket the sandbox-socket helpers read; plain test doubles satisfy it. */
export interface SandboxSocketLike {
  readyState?: number;
  deserializeAttachment?(): unknown;
  serializeAttachment?(value: unknown): void;
  close?(code?: number, reason?: string): void;
}

const WEBSOCKET_OPEN = 1;

/**
 * A sandbox socket that can still carry traffic. A socket the DO closed (marked
 * `closing` in its attachment before `close()`) can linger in `getWebSockets`
 * while its paused peer has not answered the close handshake, and a socket that
 * is not OPEN is on its way out; neither counts as an attached agent.
 */
export function isLiveSandboxSocket(socket: SandboxSocketLike): boolean {
  if (typeof socket.readyState === "number" && socket.readyState !== WEBSOCKET_OPEN) return false;
  return !isClosingSandboxSocket(socket);
}

/** True for a socket the DO closed on purpose (see `closeSandboxSockets`). */
export function isClosingSandboxSocket(socket: SandboxSocketLike): boolean {
  let attachment: unknown;
  try {
    attachment = socket.deserializeAttachment?.();
  } catch {
    attachment = undefined;
  }
  return typeof attachment === "object" && attachment !== null && (attachment as { closing?: unknown }).closing === true;
}

export function liveSandboxSockets<T extends SandboxSocketLike>(ctx: { getWebSockets(tag?: string): T[] }): T[] {
  return ctx.getWebSockets("sandbox").filter(isLiveSandboxSocket);
}

/** Close every sandbox socket the DO holds, marking each `closing` first so it stops counting as attached at once. */
export function closeSandboxSockets<T extends SandboxSocketLike>(
  ctx: { getWebSockets(tag?: string): T[] },
  reason: string,
): void {
  for (const socket of ctx.getWebSockets("sandbox")) {
    try {
      const attachment = socket.deserializeAttachment?.();
      socket.serializeAttachment?.({
        ...(typeof attachment === "object" && attachment !== null ? attachment : {}),
        closing: true,
      });
    } catch {
      // A socket whose attachment cannot be updated is still closed below.
    }
    try {
      socket.close?.(1000, reason);
    } catch {
      // Already closed.
    }
  }
}

/**
 * Whether a closed sandbox socket means the agent dropped. A close the DO
 * initiated (pause, teardown) is expected, and a close of an old socket that
 * arrives after the agent already reconnected on a newer LIVE socket (a paused
 * agent only answers the close handshake once resumed) must not mark the live
 * connection interrupted.
 */
export function isUnexpectedSandboxDisconnect<T extends SandboxSocketLike>(input: {
  expectedClose?: boolean;
  state: SessionState;
  closedSocket: T;
  sandboxSockets: readonly T[];
}): boolean {
  if (input.expectedClose || isTerminalState(input.state)) return false;
  // The DO closed this socket itself; its close may land after `expected_close` was reset (post-resume).
  if (isClosingSandboxSocket(input.closedSocket)) return false;
  return !input.sandboxSockets.some((socket) => socket !== input.closedSocket && isLiveSandboxSocket(socket));
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
