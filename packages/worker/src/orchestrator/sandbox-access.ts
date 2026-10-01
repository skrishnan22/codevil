import { redactEvent } from "../redaction.js";
import {
  collectSandboxDiagnostics,
  type SandboxDiagnostics,
} from "../sandbox.js";
import type {
  SandboxHandle,
  SandboxProvider,
  SandboxRef,
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

export async function connectSandboxHandle(options: {
  meta: { session_id: string; sandbox_ref?: SandboxRef } | null;
  provider: SandboxProvider;
  readSecret: () => Promise<string | undefined>;
}): Promise<SandboxHandle | null> {
  const ref = sandboxRefForMeta(options.meta, options.provider);
  if (!ref) return null;
  const secret = await options.readSecret();
  return options.provider.connect(ref, secret ? { secret } : undefined);
}

/** Destroy the Session's sandbox; failures are reported, never thrown. */
export async function destroySandbox(
  resolveHandle: SandboxHandleResolver,
  reason: string,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    const handle = await resolveHandle();
    await handle?.destroy(reason);
  } catch (error) {
    onError(error);
  }
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
): Promise<Response> {
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
): Promise<Response> {
  try {
    const diagnostics = await collectAgentDiagnostics(resolveHandle, secrets);
    return Response.json(redactEvent(diagnostics, secrets), { status: 200 });
  } catch {
    return Response.json({ error: "Failed to read sandbox diagnostics" }, { status: 500 });
  }
}
