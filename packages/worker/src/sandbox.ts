import type { Sandbox } from "@cloudflare/sandbox";
import { safeExceptionAttributes, safeOwnDataProperty, type ProviderPublicConfig } from "@codevil/shared";
import { redactEvent } from "./redaction.js";

export interface SandboxProcessEnvOptions {
  wsUrl: string;
  wsToken: string;
  provider: string;
  /** Registry-limited, non-secret provider values (for example Cloudflare IDs). */
  providerConfig?: ProviderPublicConfig;
  proxyBase?: string;
  /** Per-Pi-API capabilities; provider credentials never enter the sandbox. */
  proxyTokens?: Partial<Record<import("@codevil/shared").ProviderApi, string>>;
}

export interface ProvisionSandboxOptions extends SandboxProcessEnvOptions {
  binding: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  beforeStart?: (sandbox: Sandbox) => Promise<void>;
}

export interface SandboxRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export const CODEVIL_SANDBOX_OPTIONS = {
  keepAlive: true,
} as const;

export const SANDBOX_KEEPALIVE_STATE_KEY = "codevil:sandbox_keepalive";
export const SANDBOX_LIFECYCLE_EVENT_KEY = "codevil:sandbox_last_lifecycle_event";

export interface SandboxKeepAliveState {
  active: boolean;
  reason?: string;
  updated_at?: string;
}

export type SandboxLifecycleEventType =
  | "start"
  | "stop"
  | "error"
  | "activity_expired"
  | "activity_expired_deferred";

export interface SandboxLifecycleEvent {
  type: SandboxLifecycleEventType;
  at: string;
  exit_code?: number;
  reason?: string;
  error?: string;
}

export function lifecycleErrorEvent(
  error: unknown,
  secrets: readonly string[],
): SandboxLifecycleEvent {
  const details = redactEvent(safeExceptionAttributes(error), secrets);
  return {
    type: "error",
    at: new Date().toISOString(),
    error: typeof details.error === "string" ? details.error : "[UNAVAILABLE]",
  };
}

export function stopDiagnostics(params: unknown): Pick<SandboxLifecycleEvent, "exit_code" | "reason"> {
  const exitCode = safeOwnDataProperty(params, "exitCode");
  const reason = safeOwnDataProperty(params, "reason");
  return {
    ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

export interface SandboxLifecycleSnapshot {
  keepAlive?: SandboxKeepAliveState;
  lastEvent?: SandboxLifecycleEvent;
}

export interface SandboxProcessLogs {
  stdout: string;
  stderr: string;
}

export interface SandboxDiagnostics {
  logs: SandboxProcessLogs | null;
  lifecycle: SandboxLifecycleSnapshot | null;
  errors?: {
    logs?: string;
    lifecycle?: string;
  };
}

export interface SandboxDisconnectLogPayloadOptions {
  sessionId: string;
  closeCode: number;
  closeReason: string;
  state?: string;
  diagnostics: SandboxDiagnostics;
  maxLogChars?: number;
}

export interface SandboxDisconnectLogPayload {
  session_id: string;
  close_code: number;
  close_reason: string;
  state?: string;
  lifecycle?: SandboxLifecycleSnapshot;
  errors?: SandboxDiagnostics["errors"];
  stdout_tail?: string;
  stderr_tail?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

export interface SandboxLifecycleStorage {
  put(key: string, value: unknown): Promise<void>;
}

export interface CodevilKeepAliveSandbox {
  setKeepAlive?: (active: boolean) => Promise<void>;
  setCodevilKeepAlive?: (active: boolean, reason?: string) => Promise<void>;
}

export interface CodevilLifecycleSandbox {
  getCodevilLifecycleSnapshot?: () => Promise<SandboxLifecycleSnapshot>;
}

export interface SandboxLogReader {
  getProcessLogs(processId: string): Promise<SandboxProcessLogs>;
}

const DEFAULT_SANDBOX_RETRY_ATTEMPTS = 12;
const DEFAULT_SANDBOX_RETRY_DELAY_MS = 2_000;
const MAX_SANDBOX_RETRY_DELAY_MS = 15_000;

export function buildSandboxWebSocketUrl(workerUrl: string, sessionId: string): string {
  const url = new URL(`/sessions/${sessionId}/sandbox/ws`, workerUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

export function sandboxProcessEnv(options: SandboxProcessEnvOptions): Record<string, string> {
  return {
    HOME: "/home/codevil",
    USER: "codevil",
    LOGNAME: "codevil",
    CODEVIL_DO_WS_URL: options.wsUrl,
    CODEVIL_SANDBOX_WS_TOKEN: options.wsToken,
    CODEVIL_WORKSPACE: "/workspace",
    CODEVIL_PROVIDER: options.provider,
    ...(options.providerConfig && Object.keys(options.providerConfig).length > 0
      ? { CODEVIL_PROVIDER_CONFIG: JSON.stringify(options.providerConfig) }
      : {}),
    ...(options.proxyBase ? { CODEVIL_PROXY_BASE: options.proxyBase } : {}),
    ...(options.proxyTokens ? { CODEVIL_PROXY_TOKENS: JSON.stringify(options.proxyTokens) } : {}),
  };
}

export function getCodevilSandbox<Binding, T>(
  getSandbox: (
    binding: Binding,
    sessionId: string,
    options?: typeof CODEVIL_SANDBOX_OPTIONS,
  ) => T,
  binding: Binding,
  sessionId: string,
): T {
  return getSandbox(binding, sessionId, CODEVIL_SANDBOX_OPTIONS);
}

export async function setCodevilSandboxKeepAlive(
  sandbox: unknown,
  active: boolean,
  reason: string,
): Promise<void> {
  const keepAliveSandbox = sandbox as CodevilKeepAliveSandbox;
  if (typeof keepAliveSandbox.setKeepAlive === "function") {
    await keepAliveSandbox.setKeepAlive(active);
  }
  if (typeof keepAliveSandbox.setCodevilKeepAlive === "function") {
    await keepAliveSandbox.setCodevilKeepAlive(active, reason);
  }
}

export async function recordSandboxLifecycleEvent(
  storage: SandboxLifecycleStorage,
  event: SandboxLifecycleEvent,
  secrets: readonly string[],
): Promise<void> {
  await storage.put(SANDBOX_LIFECYCLE_EVENT_KEY, redactEvent(event, secrets));
}

/** Sanitize state before it crosses a Durable Object storage boundary. */
export function redactSandboxKeepAliveState(
  state: SandboxKeepAliveState,
  secrets: readonly string[],
): SandboxKeepAliveState {
  return redactEvent(state, secrets);
}

export function shouldDeferSandboxActivityExpiry(state: SandboxKeepAliveState | undefined): boolean {
  return state?.active === true;
}

export async function provisionSandbox(options: ProvisionSandboxOptions): Promise<void> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getCodevilSandbox(getSandbox, options.binding, options.sessionId);
  await provisionSandboxOnInstance(sandbox, options);
}

export async function provisionSandboxOnInstance(
  sandbox: Sandbox,
  options: Omit<ProvisionSandboxOptions, "binding">,
): Promise<void> {
  await retrySandboxOperation(() =>
    setCodevilSandboxKeepAlive(sandbox as CodevilKeepAliveSandbox, true, "session provisioning"),
  );

  const env = sandboxProcessEnv(options);

  await options.beforeStart?.(sandbox);

  await retrySandboxOperation(() => sandbox.startProcess(
    "chown 10001:10001 /workspace && chmod u+rwx /workspace && exec setpriv --reuid=10001 --regid=10001 --clear-groups -- node /app/packages/sandbox-image/dist/index.js",
    {
      cwd: "/workspace",
      env,
      processId: "codevil-agent",
      autoCleanup: true,
    },
  ));
}

export async function retrySandboxOperation<T>(
  operation: () => Promise<T>,
  options: SandboxRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_SANDBOX_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_SANDBOX_RETRY_DELAY_MS;
  const sleep = options.sleep ?? sleepFor;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientSandboxError(error)) {
        throw error;
      }

      await sleep(retryDelay(baseDelayMs, attempt));
    }
  }

  throw lastError;
}

function retryDelay(baseDelayMs: number, attempt: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_SANDBOX_RETRY_DELAY_MS);
}

function isTransientSandboxError(error: unknown): boolean {
  const candidate = safeExceptionAttributes(error).error;
  if (typeof candidate !== "string") return false;
  const message = candidate.toLowerCase();
  return message.includes("503")
    || message.includes("temporarily unavailable")
    || message.includes("no container instance")
    || message.includes("currently provisioning")
    || message.includes("failed to create session")
    || message.includes("failed to start container")
    || message.includes("container suddenly disconnected");
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function readProcessLogs(
  binding: DurableObjectNamespace<Sandbox>,
  sessionId: string,
  processId: string,
  secrets: readonly string[],
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getCodevilSandbox(getSandbox, binding, sessionId);
    return redactEvent(await sandbox.getProcessLogs(processId), secrets);
  } catch {
    return null;
  }
}

export async function readSandboxDiagnostics<Binding>(
  binding: Binding,
  sessionId: string,
  processId: string,
  secrets: readonly string[],
): Promise<SandboxDiagnostics> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getCodevilSandbox(
    getSandbox as unknown as (
      binding: Binding,
      sessionId: string,
      options?: typeof CODEVIL_SANDBOX_OPTIONS,
    ) => SandboxLogReader & CodevilLifecycleSandbox,
    binding,
    sessionId,
  );
  return collectSandboxDiagnostics(sandbox as SandboxLogReader & CodevilLifecycleSandbox, processId, secrets);
}

export async function collectSandboxDiagnostics(
  sandbox: SandboxLogReader & CodevilLifecycleSandbox,
  processId: string,
  secrets: readonly string[],
): Promise<SandboxDiagnostics> {
  const [logs, lifecycle] = await Promise.allSettled([
    sandbox.getProcessLogs(processId),
    typeof sandbox.getCodevilLifecycleSnapshot === "function"
      ? sandbox.getCodevilLifecycleSnapshot()
      : Promise.resolve(null),
  ]);

  const errors: SandboxDiagnostics["errors"] = {};
  if (logs.status === "rejected") errors.logs = errorMessage(logs.reason, secrets);
  if (lifecycle.status === "rejected") errors.lifecycle = errorMessage(lifecycle.reason, secrets);

  return {
    logs: logs.status === "fulfilled" ? redactEvent(logs.value, secrets) : null,
    lifecycle: lifecycle.status === "fulfilled" ? redactEvent(lifecycle.value, secrets) : null,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

function errorMessage(error: unknown, secrets: readonly string[]): string {
  const details = redactEvent(safeExceptionAttributes(error), secrets);
  return typeof details.error === "string" ? details.error : "[UNAVAILABLE]";
}

export function buildSandboxDisconnectLogPayload(
  options: SandboxDisconnectLogPayloadOptions,
): SandboxDisconnectLogPayload {
  const maxLogChars = Math.max(0, options.maxLogChars ?? 4_096);
  const stdout = boundedTail(options.diagnostics.logs?.stdout, maxLogChars);
  const stderr = boundedTail(options.diagnostics.logs?.stderr, maxLogChars);

  return {
    session_id: options.sessionId,
    close_code: options.closeCode,
    close_reason: options.closeReason || "none",
    ...(options.state ? { state: options.state } : {}),
    ...(options.diagnostics.lifecycle ? { lifecycle: options.diagnostics.lifecycle } : {}),
    ...(options.diagnostics.errors ? { errors: options.diagnostics.errors } : {}),
    ...(stdout.tail !== undefined ? { stdout_tail: stdout.tail } : {}),
    ...(stderr.tail !== undefined ? { stderr_tail: stderr.tail } : {}),
    ...(stdout.truncated ? { stdout_truncated: true } : {}),
    ...(stderr.truncated ? { stderr_truncated: true } : {}),
  };
}

function boundedTail(value: string | undefined, maxChars: number): {
  tail?: string;
  truncated: boolean;
} {
  if (value === undefined || value.length === 0) return { truncated: false };
  if (value.length <= maxChars) return { tail: value, truncated: false };
  return {
    tail: value.slice(value.length - maxChars),
    truncated: true,
  };
}
