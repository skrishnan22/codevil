import { isTerminalState, safeExceptionAttributes } from "@codevil/shared";
import { redactEvent } from "../redaction.js";
import { liveSandboxSockets } from "../sandbox-connection.js";
import { SandboxNotFoundError } from "../sandbox-provider/types.js";
import { sandboxProviderMaxLeaseMs } from "../sandbox-provider/index.js";
import { finishRunAndDrainQueue } from "./agent-run-coordinator.js";
import type { OrchestratorHost } from "./host.js";
import { validatePreviewAccess } from "./preview.js";
import { listOpenQuestionIds } from "./questions-store.js";
import {
  destroySandbox,
  registerSandboxSecret,
  sandboxRefForMeta,
  SANDBOX_SECRET_KEY,
} from "./sandbox-access.js";
import {
  idlePauseDeadline,
  leaseRenewDeadline,
  sandboxLeaseMs,
  shouldPauseSandbox,
  type IdlePauseInput,
} from "./sandbox-lifecycle.js";
import { parseMaxTimeMs } from "./session-guards.js";

export const PREVIEW_RESUME_TIMEOUT_MS = 15_000;
export const RESUME_ATTEMPTS = 3;
/** Delay before each resume attempt (the first runs immediately). */
const RESUME_RETRY_DELAYS_MS: readonly number[] = [0, 250, 750];
/** Path the sandbox agent rereads before each (re)connection attempt. */
const SANDBOX_WS_TOKEN_FILE = "/run/codevil/ws-token";

const pausing = new WeakMap<OrchestratorHost, Promise<boolean>>();
const resuming = new WeakMap<OrchestratorHost, Promise<void>>();

/** True while a pause is in flight: the sandbox may freeze at any moment, so it must not receive work. */
export function isSandboxPausing(host: OrchestratorHost): boolean {
  return pausing.has(host);
}

/** A sandbox socket is attached and the sandbox is not about to be paused. */
export function sandboxSocketAttached(host: OrchestratorHost): boolean {
  return liveSandboxSockets(host.ctx).length > 0 && !pausing.has(host);
}

/**
 * Drains queued agent work once the session is usable; the cache job no longer
 * gates agent work (snapshots are best-effort and validated on restore, so runs
 * and backups may overlap). Lives here, not in sandbox-handlers, so pause
 * recovery can drain without an import cycle.
 */
export function drainQueuedAgentWorkIfReady(host: OrchestratorHost): void {
  if (
    host.meta?.state === "ready"
    && !host.meta.active_run
    && host.meta.queued_runs.length > 0
    && sandboxSocketAttached(host)
  ) {
    finishRunAndDrainQueue(host, "completed");
  }
}

function logFailure(host: OrchestratorHost, event: string, error: unknown, extra: Record<string, unknown> = {}): void {
  host.getTracer()?.log("ERROR", event, {
    ...extra,
    ...redactEvent(safeExceptionAttributes(error), host.redactionSecrets),
  });
}

function providerCapabilities(host: OrchestratorHost): { pauseResume: boolean; leaseRenewal: boolean } {
  try {
    const { pauseResume, leaseRenewal } = host.sandboxProvider().capabilities;
    return { pauseResume, leaseRenewal };
  } catch {
    return { pauseResume: false, leaseRenewal: false };
  }
}

function providerSupportsPause(host: OrchestratorHost): boolean {
  return providerCapabilities(host).pauseResume;
}

const ACTIVITY_WRITE_INTERVAL_MS = 1_000;

/** `preview`: high-frequency authenticated preview traffic; `event`: everything else. */
export type ActivitySource = "event" | "preview";

/**
 * Counts a user-visible action toward the idle-pause clock. A no-op for
 * providers that cannot pause (their meta stays untouched). Only the meta write
 * is throttled; the alarm is always re-armed while an idle deadline exists so a
 * run that finishes right after a request still gets its idle alarm.
 */
export function recordSessionActivity(
  host: OrchestratorHost,
  now: number = Date.now(),
  source: ActivitySource = "event",
): void {
  const meta = host.meta;
  if (!meta || !providerSupportsPause(host)) return;
  const lastMs = meta.last_activity_at ? Date.parse(meta.last_activity_at) : Number.NaN;
  const throttled = Number.isFinite(lastMs) && now - lastMs >= 0 && now - lastMs < ACTIVITY_WRITE_INTERVAL_MS;
  if (!throttled) {
    meta.last_activity_at = new Date(now).toISOString();
    host.saveMeta();
  }
  // Discrete events (requests, run finishes) can change whether an idle deadline
  // applies, so they always re-arm. Preview traffic arrives in bursts and cannot
  // change eligibility, so it re-arms only when the idle deadline actually moved
  // (a write happened).
  if (source === "preview" && throttled) return;
  if (sandboxAlarmDeadlines(host).idlePauseAt !== null) void armAlarmSafely(host);
}

export function idlePauseInput(host: OrchestratorHost, now: number): IdlePauseInput | null {
  const meta = host.meta;
  if (!meta) return null;
  const activeRunId = meta.active_run?.id;
  return {
    now,
    pauseSupported: providerSupportsPause(host),
    sessionState: meta.state,
    paused: Boolean(meta.sandbox_paused_at),
    sandboxConnected: sandboxSocketAttached(host),
    ...(meta.sandbox_disconnected_at ? { disconnectedAt: meta.sandbox_disconnected_at } : {}),
    hasActiveRun: Boolean(meta.active_run),
    queuedRuns: meta.queued_runs.length,
    openQuestions: activeRunId ? listOpenQuestionIds(host.sql, activeRunId).length : 0,
    lastActivityAt: meta.last_activity_at ?? meta.created_at,
    maxIdleMs: parseMaxTimeMs(meta.max_idle_time ?? "10m"),
  };
}

/**
 * Deadlines the alarm must wake for. Null means "not applicable right now";
 * Cloudflare Sessions (no pause support) always get nulls.
 */
export function sandboxAlarmDeadlines(host: OrchestratorHost): {
  idlePauseAt: number | null;
  leaseRenewAt: number | null;
} {
  const meta = host.meta;
  if (!meta || isTerminalState(meta.state) || meta.sandbox_paused_at) {
    return { idlePauseAt: null, leaseRenewAt: null };
  }

  // Every pause condition except the clock: an infinite `now` passes the time check.
  const input = idlePauseInput(host, Number.POSITIVE_INFINITY);
  const idlePauseAt = input && shouldPauseSandbox(input) ? idlePauseDeadline(input) : null;
  const leaseRenewAt = meta.sandbox_ref && providerCapabilities(host).leaseRenewal
    ? leaseRenewDeadline({ renewedAt: meta.sandbox_lease_renewed_at, createdAt: meta.created_at })
    : null;
  return { idlePauseAt, leaseRenewAt };
}

/** Pauses the sandbox when the Session has been idle long enough. Resolves true only if it paused. */
export function pauseIdleSandbox(host: OrchestratorHost, now: number): Promise<boolean> {
  if (pausing.has(host)) return Promise.resolve(false);
  const input = idlePauseInput(host, now);
  if (!input || !shouldPauseSandbox(input)) return Promise.resolve(false);

  // `pausing` is set synchronously (before any await) so requests arriving
  // while the sandbox is being paused queue instead of reaching a freezing agent.
  // Recovery runs after the marker is cleared so a drained run can reach the sandbox again.
  const run = doPause(host, now)
    .finally(() => pausing.delete(host))
    .then(async (paused) => {
      if (!paused) await recoverAfterFailedPause(host);
      return paused;
    });
  pausing.set(host, run);
  return run;
}

async function doPause(host: OrchestratorHost, now: number): Promise<boolean> {
  const meta = host.meta!;
  meta.expected_close = true;
  host.saveMeta();

  try {
    const handle = await host.sandboxHandle();
    if (!handle?.pause) throw new Error("Sandbox provider cannot pause");
    await handle.pause();
  } catch (error) {
    if (error instanceof SandboxNotFoundError) {
      await failLostSandbox(host);
      return false;
    }
    // A terminal session already owns expected_close (teardown set it).
    if (!isTerminalState(meta.state)) {
      meta.expected_close = false;
      host.saveMeta();
    }
    logFailure(host, "sandbox.pause.failed", error);
    return false;
  }

  // The session may have ended while the provider call was in flight.
  if (isTerminalState(meta.state)) return false;

  meta.sandbox_paused_at = new Date(now).toISOString();
  host.saveMeta();
  host.closeSandboxSockets("sandbox paused");
  host.updateDirectory({ sandbox_state: "paused" });
  host.appendAndBroadcast({ type: "status", message: "Sandbox paused (idle)." });
  // A request that queued while the pause was in flight is still waiting.
  if (meta.queued_runs.length > 0) host.requestSandboxResume();
  return true;
}

/**
 * A failed pause leaves the sandbox running. While `expected_close` was set, a
 * dropped socket was ignored, so if no live socket remains start the reconnect
 * grace; then release work that queued during the pause and re-arm the alarm
 * (which retries the pause) instead of waiting for the next tick.
 */
async function recoverAfterFailedPause(host: OrchestratorHost): Promise<void> {
  const meta = host.meta;
  if (!meta || isTerminalState(meta.state) || meta.sandbox_paused_at) return;
  if (liveSandboxSockets(host.ctx).length === 0 && !meta.sandbox_disconnected_at) {
    meta.sandbox_disconnected_at = new Date().toISOString();
    host.saveMeta();
    host.appendAndBroadcast({ type: "status", message: "Sandbox connection interrupted. Reconnecting…" });
    host.updateDirectory({});
  }
  drainQueuedAgentWorkIfReady(host);
  flushPendingPreviewAction(host);
  await armAlarmSafely(host);
}

/** Resumes a paused sandbox. Concurrent callers share one in-flight resume. */
export function resumeSandbox(
  host: OrchestratorHost,
  options: { retryDelaysMs?: readonly number[] } = {},
): Promise<void> {
  const inflight = resuming.get(host);
  if (inflight) return inflight;
  if (!host.meta?.sandbox_paused_at && !pausing.has(host)) return Promise.resolve();

  const run = doResume(host, options.retryDelaysMs ?? RESUME_RETRY_DELAYS_MS).finally(() => resuming.delete(host));
  resuming.set(host, run);
  return run;
}

async function doResume(host: OrchestratorHost, retryDelaysMs: readonly number[]): Promise<void> {
  // A pause in flight finishes first; resuming a half-paused sandbox would race it.
  await pausing.get(host)?.catch(() => false);
  const meta = host.meta;
  if (!meta?.sandbox_paused_at || isTerminalState(meta.state)) return;

  const provider = host.sandboxProvider();
  const ref = sandboxRefForMeta(meta, provider);
  if (!ref) {
    await failLostSandbox(host);
    return;
  }

  for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt++) {
    const delayMs = retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    // Teardown or another resume may have settled the Session while we waited.
    if (!meta.sandbox_paused_at || isTerminalState(meta.state)) return;

    try {
      const now = Date.now();
      const secret = await host.ctx.storage.get<string>(SANDBOX_SECRET_KEY);
      const handle = await provider.connect(ref, {
        leaseMs: sandboxLeaseMs({
          now,
          createdAt: Date.parse(meta.created_at),
          maxTimeMs: parseMaxTimeMs(meta.max_time),
          providerMaxMs: sandboxProviderMaxLeaseMs(host.workerEnv, provider.name),
        }),
        ...(secret ? { secret } : {}),
      });
      registerSandboxSecret(host.redactionSecrets, handle.secret);
      // Teardown may have run while connect was in flight; do not touch a sandbox that is going away.
      if (!meta.sandbox_paused_at || isTerminalState(meta.state)) return;
      // The agent adopts a changed token file on its next reconnect; the
      // in-memory token it holds may have expired while paused.
      await handle.writeFile(SANDBOX_WS_TOKEN_FILE, await host.issueSandboxWebSocketToken(), {
        mode: 0o600,
        owner: "codevil",
      });
      await completeResume(host, now);
      return;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        await failLostSandbox(host);
        return;
      }
      logFailure(host, "sandbox.resume.failed", error, { attempt: attempt + 1 });
    }
  }

  await failSandboxResume(host);
}

async function completeResume(host: OrchestratorHost, now: number): Promise<void> {
  const meta = host.meta!;
  // The session may have ended (and the sandbox been destroyed) mid-resume.
  if (!meta.sandbox_paused_at || isTerminalState(meta.state)) return;

  meta.sandbox_paused_at = undefined;
  meta.expected_close = false;
  if (providerCapabilities(host).leaseRenewal) meta.sandbox_lease_renewed_at = new Date(now).toISOString();
  // The agent reconnects on its own; start the reconnect grace so a resumed
  // sandbox whose agent never returns fails instead of stranding queued runs.
  // Skip when the agent already reconnected while the resume was in flight.
  // Closed-but-lingering sockets do not count: only a live agent socket does.
  if (liveSandboxSockets(host.ctx).length === 0) {
    meta.sandbox_disconnected_at = new Date().toISOString();
  }
  host.saveMeta();
  host.updateDirectory({ sandbox_state: meta.state === "cloning_repo" ? "cloning" : "ready" });
  host.appendAndBroadcast({ type: "status", message: "Sandbox resumed." });
  // The agent may have reconnected (old token still valid) while the resume was in
  // flight; that accept ran while the paused marker was set, so release what it left behind.
  drainQueuedAgentWorkIfReady(host);
  flushPendingPreviewAction(host);
  await armAlarmSafely(host);
}

/**
 * A paused marker with an attached sandbox socket and no resume in flight is
 * stale (e.g. the Durable Object restarted mid-resume): a paused agent cannot
 * hold a socket. Clear it so lease renewal and idle pause work again.
 */
export function clearStalePausedMarker(host: OrchestratorHost): boolean {
  const meta = host.meta;
  if (!meta?.sandbox_paused_at || resuming.has(host) || !sandboxSocketAttached(host)) return false;
  meta.sandbox_paused_at = undefined;
  meta.expected_close = false;
  host.saveMeta();
  flushPendingPreviewAction(host);
  return true;
}

async function armAlarmSafely(host: OrchestratorHost, now?: number): Promise<void> {
  try {
    await host.armNextAlarm(now);
  } catch (error) {
    logFailure(host, "alarm.arm.failed", error);
  }
}

/** Extends the provider lease on schedule while the sandbox is running. */
export async function renewSandboxLeaseIfDue(host: OrchestratorHost, now: number): Promise<void> {
  const meta = host.meta;
  if (
    !meta
    || !meta.sandbox_ref
    || meta.sandbox_paused_at
    || isTerminalState(meta.state)
    || pausing.has(host)
    || !providerCapabilities(host).leaseRenewal
    || now < leaseRenewDeadline({ renewedAt: meta.sandbox_lease_renewed_at, createdAt: meta.created_at })
  ) {
    return;
  }

  try {
    const handle = await host.sandboxHandle();
    if (!handle) return;
    await handle.renewLease(sandboxLeaseMs({
      now,
      createdAt: Date.parse(meta.created_at),
      maxTimeMs: parseMaxTimeMs(meta.max_time),
      providerMaxMs: sandboxProviderMaxLeaseMs(host.workerEnv, host.sandboxProvider().name),
    }));
    if (isTerminalState(meta.state)) return;
    meta.sandbox_lease_renewed_at = new Date(now).toISOString();
    host.saveMeta();
  } catch (error) {
    if (error instanceof SandboxNotFoundError) {
      await failLostSandbox(host);
      return;
    }
    // The alarm retries a past-due renewal after a bounded delay.
    logFailure(host, "sandbox.lease_renew.failed", error);
  }
}

/** Fails every run the Session still owns (active and queued) with one message. */
function failOutstandingRuns(host: OrchestratorHost, message: string, questionReason: string): string | undefined {
  const meta = host.meta!;
  const activeRunId = meta.active_run?.id;
  if (meta.active_run) {
    meta.active_run = { ...meta.active_run, state: "failed" };
    host.cancelOpenQuestions(meta.active_run.id, questionReason);
    host.appendAndBroadcast({ type: "agent_run_failed", run_id: meta.active_run.id, message });
  }
  for (const run of meta.queued_runs) {
    host.appendAndBroadcast({ type: "agent_run_failed", run_id: run.id, message });
  }
  meta.queued_runs = [];
  host.saveMeta();
  return activeRunId;
}

async function failSession(
  host: OrchestratorHost,
  message: string,
  questionReason: string,
): Promise<boolean> {
  const meta = host.meta;
  if (!meta || isTerminalState(meta.state)) return false;
  if (!host.transition("failed")) return false;
  meta.sandbox_paused_at = undefined;
  meta.pending_preview_action = undefined;
  const activeRunId = failOutstandingRuns(host, message, questionReason);
  host.appendAndBroadcast({ type: "error", message });
  host.updateDirectory({
    room_state: "failed",
    sandbox_state: "failed",
    active_run_state: activeRunId ? "failed" : null,
  });
  return true;
}

/** The provider no longer has the sandbox. Never recreate silently. */
export async function failLostSandbox(host: OrchestratorHost): Promise<void> {
  if (!(await failSession(host, "Sandbox expired.", "sandbox expired"))) return;
  await armAlarmSafely(host, Date.now() - 1);
}

async function failSandboxResume(host: OrchestratorHost): Promise<void> {
  if (!(await failSession(host, "Sandbox failed to resume.", "sandbox failed to resume"))) return;
  await host.terminateSandbox("resume failed");
  await armAlarmSafely(host, Date.now() - 1);
}

/**
 * Destroys the Session's sandbox whether it is running or paused (a paused
 * E2B sandbox never expires, so this is its only cleanup).
 */
export async function terminateSandbox(host: OrchestratorHost, reason: string): Promise<void> {
  if (!host.meta) return;
  // A pause still in flight would otherwise land after the destroy and leave a
  // paused sandbox that never expires.
  await pausing.get(host)?.catch(() => false);
  host.meta.expected_close = true;
  host.meta.sandbox_paused_at = undefined;
  host.meta.pending_preview_action = undefined;
  host.saveMeta();
  await destroySandbox(() => host.sandboxHandle(), reason, (error) => {
    logFailure(host, "sandbox.stop.failed", error);
  });
  host.closeSandboxSockets(reason);
}

/** Alarm branch: end the Session at `max_time`, destroying its sandbox even when paused. */
export async function expireSessionAtMaxTime(host: OrchestratorHost, now: number): Promise<boolean> {
  const meta = host.meta;
  if (!meta) return false;
  const maxTimeMs = parseMaxTimeMs(meta.max_time);
  if (maxTimeMs === null || now < Date.parse(meta.created_at) + maxTimeMs) return false;

  const activeRunId = meta.active_run?.id;
  host.transition("timed_out");
  if (activeRunId) host.cancelOpenQuestions(activeRunId, "session timed out");
  host.appendAndBroadcast({ type: "error", message: `Session timed out after ${meta.max_time}.` });
  await host.terminateSandbox("timed out");
  return true;
}

export function buildPreviewStartMessage(
  meta: { plan_model: string; provider: string; prompt: string },
  appKey?: string,
) {
  return {
    type: "preview_start" as const,
    model: meta.plan_model,
    provider: meta.provider,
    task_prompt: meta.prompt,
    app_key: appKey,
  };
}

/**
 * A preview command (start or stop) issued while the sandbox is paused, about
 * to be paused, or reconnecting after a resume resumes it and is remembered
 * (the latest command wins); it is replayed once the agent reconnects. Returns
 * false when the command can go straight to the agent.
 */
export function deferPreviewCommandWhileUnavailable(
  host: OrchestratorHost,
  type: "start" | "stop",
  appKey?: string,
): boolean {
  const meta = host.meta;
  if (!meta) return false;
  const unavailable = previewUnavailableReason(host);
  if (!unavailable) {
    // The command is about to reach the agent and supersedes anything deferred earlier.
    if (meta.pending_preview_action) {
      meta.pending_preview_action = undefined;
      host.saveMeta();
    }
    return false;
  }
  meta.pending_preview_action = { type, ...(type === "start" && appKey !== undefined ? { app_key: appKey } : {}) };
  host.saveMeta();
  host.recordActivity();
  host.requestSandboxResume();
  host.appendAndBroadcast({
    type: "status",
    message: `Sandbox is ${unavailable}; the preview will ${type} when it reconnects.`,
  });
  return true;
}

/**
 * Why a preview command cannot reach the agent right now, for providers that
 * pause: the sandbox is paused or being paused (`resuming`), or it was resumed
 * and the agent has not reconnected yet (`reconnecting`). Null otherwise,
 * including always for providers that cannot pause.
 */
function previewUnavailableReason(host: OrchestratorHost): "resuming" | "reconnecting" | null {
  const meta = host.meta;
  if (!meta || isTerminalState(meta.state) || !providerSupportsPause(host)) return null;
  if (meta.sandbox_paused_at || pausing.has(host)) return "resuming";
  if (meta.sandbox_disconnected_at && !sandboxSocketAttached(host)) return "reconnecting";
  return null;
}

/** Replays the deferred preview command exactly once, when a live agent socket exists. */
export function flushPendingPreviewAction(host: OrchestratorHost): boolean {
  const meta = host.meta;
  if (
    !meta?.pending_preview_action
    || meta.sandbox_paused_at
    || isTerminalState(meta.state)
    || !sandboxSocketAttached(host)
  ) {
    return false;
  }
  const { type, app_key: appKey } = meta.pending_preview_action;
  meta.pending_preview_action = undefined;
  host.saveMeta();
  host.sendToSandbox(type === "start" ? buildPreviewStartMessage(meta, appKey) : { type: "preview_stop" });
  return true;
}

/**
 * Runs only for an authenticated preview request: counts it as activity and
 * resumes a paused sandbox, answering 503 if that takes too long.
 */
export async function prepareAuthenticatedPreview(
  host: OrchestratorHost,
  timeoutMs: number = PREVIEW_RESUME_TIMEOUT_MS,
): Promise<Response | null> {
  host.recordActivity("preview");
  if (!host.meta?.sandbox_paused_at && !pausing.has(host)) return null;

  const resume = resumeSandbox(host);
  // Keep resuming after a timed-out request has been answered.
  host.ctx.waitUntil(resume.catch(() => undefined));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([resume.then(() => "resumed" as const), timedOut]);
    if (outcome === "timeout") return resumingResponse();
  } catch (error) {
    logFailure(host, "sandbox.resume.preview_failed", error);
    return resumingResponse();
  } finally {
    clearTimeout(timer);
  }

  // Resume may have failed the Session; re-check before proxying.
  return host.meta ? validatePreviewAccess(host.meta) : null;
}

function resumingResponse(): Response {
  return new Response("Sandbox is resuming. Retry shortly.", {
    status: 503,
    headers: { "Retry-After": "2" },
  });
}
