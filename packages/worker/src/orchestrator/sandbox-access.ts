import { redactEvent } from "../redaction.js";
import {
  collectSandboxDiagnostics,
  type SandboxDiagnostics,
} from "../sandbox.js";
import {
  SandboxNotFoundError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRef,
} from "../sandbox-provider/types.js";

export const AGENT_PROCESS_ID = "codevil-agent";

/** Durable Object storage key for the provider secret (E2B traffic token). */
export const SANDBOX_SECRET_KEY = "codevil:sandbox_secret";

/** Add a provider secret to the live redaction list, in place and at most once. */
export function registerSandboxSecret(secrets: string[], secret: string | undefined): void {
  const normalized = secret?.trim();
  if (normalized && !secrets.includes(normalized)) secrets.push(normalized);
}

/** Cold start: put the persisted provider secret back on the redaction list. */
export async function loadStoredSandboxSecret(
  storage: { get<T>(key: string): Promise<T | undefined> },
  secrets: string[],
): Promise<void> {
  registerSandboxSecret(secrets, await storage.get<string>(SANDBOX_SECRET_KEY));
}

export type SandboxHandleResolver = () => Promise<SandboxHandle | null>;

/**
 * The sandbox a Session talks to. Legacy Cloudflare Sessions predate
 * `sandbox_ref`; their sandbox id is the Session id. Any other provider
 * without a ref has no sandbox yet.
 */
export function sandboxRefForMeta(
  meta: { session_id: string; sandbox_ref?: SandboxRef } | null,
  provider: Pick<SandboxProvider, "name">,
): SandboxRef | null {
  if (!meta) return null;
  if (meta.sandbox_ref) return meta.sandbox_ref;
  return provider.name === "cloudflare"
    ? { provider: "cloudflare", id: meta.session_id }
    : null;
}

/**
 * Per-Orchestrator cache of the connected handle, keyed by provider and
 * sandbox id. Every authenticated preview request needs a handle, and for E2B
 * connecting is an API call. The cache holds the in-flight promise so
 * concurrent requests share one connect; failures and null results are never
 * cached, and a `SandboxNotFoundError` from any call on a cached handle drops it.
 */
export interface SandboxHandleCache {
  get(key: string, load: () => Promise<SandboxHandle | null>): Promise<SandboxHandle | null>;
  /** Drop the cached handle (pause, resume, terminate, loss). In-flight loads finish but are not kept. */
  invalidate(): void;
}

export function createSandboxHandleCache(): SandboxHandleCache {
  let entry: { key: string; promise: Promise<SandboxHandle | null> } | null = null;

  const drop = (promise: Promise<SandboxHandle | null>): void => {
    if (entry?.promise === promise) entry = null;
  };

  return {
    get(key, load) {
      if (entry?.key === key) return entry.promise;
      const promise: Promise<SandboxHandle | null> = load().then(
        (handle) => {
          if (!handle) {
            drop(promise);
            return null;
          }
          return invalidateOnNotFound(handle, () => drop(promise));
        },
        (error: unknown) => {
          drop(promise);
          throw error;
        },
      );
      entry = { key, promise };
      return promise;
    },
    invalidate() {
      entry = null;
    },
  };
}

/** Wraps every handle call so a `SandboxNotFoundError` evicts the (now useless) handle. */
function invalidateOnNotFound(handle: SandboxHandle, onNotFound: () => void): SandboxHandle {
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await call(...args);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) onNotFound();
        throw error;
      }
    };
  return {
    ...handle,
    exec: guard(handle.exec.bind(handle)),
    writeFile: guard(handle.writeFile.bind(handle)),
    startProcess: guard(handle.startProcess.bind(handle)),
    readProcessLogs: guard(handle.readProcessLogs.bind(handle)),
    fetchPort: guard(handle.fetchPort.bind(handle)),
    renewLease: guard(handle.renewLease.bind(handle)),
    destroy: guard(handle.destroy.bind(handle)),
    ...(handle.readLifecycle ? { readLifecycle: guard(handle.readLifecycle.bind(handle)) } : {}),
    ...(handle.pause ? { pause: guard(handle.pause.bind(handle)) } : {}),
  };
}

export async function connectSandboxHandle(options: {
  meta: { session_id: string; sandbox_ref?: SandboxRef; sandbox_paused_at?: string } | null;
  provider: SandboxProvider;
  readSecret: () => Promise<string | undefined>;
  /** Live redaction list; any secret the handle ends up using is added to it. */
  secrets?: string[];
  /** Persist a secret the provider supplied because none was stored. */
  storeSecret?: (secret: string) => Promise<void>;
  /** Reuse a connected handle across calls; see {@link createSandboxHandleCache}. */
  cache?: SandboxHandleCache;
}): Promise<SandboxHandle | null> {
  // Connecting would silently resume a paused VM (no token write, lease or marker
  // update). Only the resume path may wake it, and it calls `provider.connect` itself.
  if (options.meta?.sandbox_paused_at) {
    options.cache?.invalidate();
    return null;
  }
  const ref = sandboxRefForMeta(options.meta, options.provider);
  if (!ref) return null;
  const connect = async (): Promise<SandboxHandle> => {
    const secret = await options.readSecret();
    const handle = await options.provider.connect(ref, secret ? { secret } : undefined);
    if (options.secrets) registerSandboxSecret(options.secrets, handle.secret);
    if (!secret && handle.secret) await options.storeSecret?.(handle.secret);
    return handle;
  };
  // Cloudflare handles wrap a Durable Object stub that many exceptions leave
  // permanently broken, so every lookup must build a fresh one; only E2B (an
  // HTTP API connection) is safe to reuse.
  const cache = options.provider.name === "cloudflare" ? undefined : options.cache;
  return cache ? cache.get(`${ref.provider}:${ref.id}`, connect) : connect();
}

/**
 * Destroy the Session's sandbox; failures are reported, never thrown.
 *
 * A paused sandbox is killed by reference when the provider can (connecting
 * would resume it first), and a failed connect falls back to the same. A
 * sandbox that is already gone counts as destroyed.
 */
export async function destroySandbox(
  resolveHandle: SandboxHandleResolver,
  reason: string,
  onError: (error: unknown) => void,
  fallback: { paused?: boolean; destroyByRef?: () => Promise<void> } = {},
): Promise<void> {
  try {
    if (fallback.paused && fallback.destroyByRef) {
      await fallback.destroyByRef();
      return;
    }
    let handle: SandboxHandle | null;
    try {
      handle = await resolveHandle();
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      if (!fallback.destroyByRef) throw error;
      await fallback.destroyByRef();
      return;
    }
    await handle?.destroy(reason);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return;
    onError(error);
  }
}

/** Body for log and diagnostics reads of a paused sandbox, which must not wake the VM. */
export function pausedSandboxResponse(): Response {
  return Response.json(
    { paused: true, message: "Sandbox is paused. Send an Agent Request or open the preview to resume it." },
    { status: 200 },
  );
}

/** Agent process logs, redacted; null when the sandbox cannot be read. */
export async function readRedactedAgentLogs(
  resolveHandle: SandboxHandleResolver,
  secrets: readonly string[],
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const handle = await resolveHandle();
    if (!handle) return null;
    return redactEvent(await handle.readProcessLogs(AGENT_PROCESS_ID), secrets);
  } catch {
    return null;
  }
}

export async function collectAgentDiagnostics(
  resolveHandle: SandboxHandleResolver,
  secrets: readonly string[],
): Promise<SandboxDiagnostics> {
  const handle = await resolveHandle();
  if (!handle) throw new Error("Sandbox not found");
  return collectSandboxDiagnostics(
    {
      getProcessLogs: (processId) => handle.readProcessLogs(processId),
      ...(handle.readLifecycle ? { getCodevilLifecycleSnapshot: () => handle.readLifecycle!() } : {}),
    },
    AGENT_PROCESS_ID,
    secrets,
  );
}

/** Body and status for `GET /sessions/:id/logs`. Redacted at this boundary. */
export async function sandboxLogsResponse(
  resolveHandle: SandboxHandleResolver,
  secrets: readonly string[],
  options: { paused?: boolean } = {},
): Promise<Response> {
  if (options.paused) return pausedSandboxResponse();
  try {
    const handle = await resolveHandle();
    if (!handle) throw new Error("Sandbox not found");
    const logs = await handle.readProcessLogs(AGENT_PROCESS_ID);
    return Response.json(redactEvent(logs, secrets), { status: 200 });
  } catch {
    return Response.json({ error: "Failed to read sandbox logs" }, { status: 500 });
  }
}

/** Body and status for `GET /sessions/:id/diagnostics`. Redacted at this boundary. */
export async function sandboxDiagnosticsResponse(
  resolveHandle: SandboxHandleResolver,
  secrets: readonly string[],
  options: { paused?: boolean } = {},
): Promise<Response> {
  if (options.paused) return pausedSandboxResponse();
  try {
    const diagnostics = await collectAgentDiagnostics(resolveHandle, secrets);
    return Response.json(redactEvent(diagnostics, secrets), { status: 200 });
  } catch {
    return Response.json({ error: "Failed to read sandbox diagnostics" }, { status: 500 });
  }
}
