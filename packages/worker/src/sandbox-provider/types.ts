import type { SandboxLifecycleSnapshot } from "../sandbox.js";

export type SandboxProviderName = "e2b" | "cloudflare";
export const SANDBOX_PROVIDER_NAMES: readonly SandboxProviderName[] = ["e2b", "cloudflare"];

export interface SandboxRef { provider: SandboxProviderName; id: string }
export interface ShellResult { stdout: string; stderr: string; exitCode: number }
export type SandboxLifecycleView = SandboxLifecycleSnapshot;

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  /** `leaseRenewal`: the Orchestrator must periodically extend a timed lease (Cloudflare uses keepalive instead). */
  readonly capabilities: { pauseResume: boolean; workspaceCache: boolean; leaseRenewal: boolean };
  create(options: { sessionId: string; leaseMs: number }): Promise<SandboxHandle>;
  /** `secret` is the opaque value returned as `handle.secret` at create time. */
  connect(ref: SandboxRef, options?: { leaseMs?: number; secret?: string }): Promise<SandboxHandle>;
}

export interface SandboxHandle {
  readonly ref: SandboxRef;
  /** Provider-specific secret the Orchestrator must persist and redact (E2B traffic token). */
  readonly secret?: string;
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; user?: "root" | "codevil" }): Promise<ShellResult>;
  writeFile(path: string, content: string, options?: { mode?: number; owner?: "root" | "codevil" }): Promise<void>;
  startProcess(command: string, options: { processId: string; cwd: string; env: Record<string, string> }): Promise<void>;
  readProcessLogs(processId: string): Promise<{ stdout: string; stderr: string }>;
  readLifecycle?(): Promise<SandboxLifecycleView | null>;
  fetchPort(port: number, request: Request): Promise<Response>;
  renewLease(ms: number): Promise<void>;
  pause?(): Promise<void>;
  destroy(reason: string): Promise<void>;
  /** Present only when provider.capabilities.workspaceCache is true. */
  readonly workspaceCache?: import("../workspace-cache.js").WorkspaceCacheSandbox;
}

export class SandboxNotFoundError extends Error {
  constructor(message = "Sandbox not found") { super(message); this.name = "SandboxNotFoundError"; }
}

export function parseSandboxProviderName(value: unknown): SandboxProviderName | undefined {
  return typeof value === "string" && (SANDBOX_PROVIDER_NAMES as readonly string[]).includes(value)
    ? value as SandboxProviderName
    : undefined;
}
