import {
  CODEVIL_SANDBOX_OPTIONS,
  getCodevilSandbox,
  retrySandboxOperation,
  setCodevilSandboxKeepAlive,
} from "../sandbox.js";
import type { WorkspaceCacheSandbox } from "../workspace-cache.js";
import type {
  SandboxHandle,
  SandboxLifecycleView,
  SandboxProvider,
  SandboxRef,
  ShellResult,
} from "./types.js";
import { OWNER_IDS, shellQuote } from "./shell.js";

/** The slice of `@cloudflare/sandbox`'s Sandbox the adapter relies on. */
export interface CloudflareSandboxLike extends WorkspaceCacheSandbox {
  exec(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeFile(path: string, content: string): Promise<unknown>;
  startProcess(command: string, options: {
    cwd: string;
    env: Record<string, string>;
    processId: string;
    autoCleanup: boolean;
  }): Promise<unknown>;
  getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string }>;
  getCodevilLifecycleSnapshot?: () => Promise<SandboxLifecycleView>;
  fetch(request: Request): Promise<Response>;
  stop(): Promise<unknown>;
}

export type GetCloudflareSandbox = (
  binding: unknown,
  sandboxId: string,
  options?: typeof CODEVIL_SANDBOX_OPTIONS,
) => unknown;

export interface CloudflareSandboxProviderOptions {
  binding: unknown;
  /** Injected in tests; production lazily imports `@cloudflare/sandbox`. */
  getSandbox?: GetCloudflareSandbox;
}

export function createCloudflareSandboxProvider(
  providerOptions: CloudflareSandboxProviderOptions,
): SandboxProvider {
  const lookup = async (sandboxId: string): Promise<CloudflareSandboxLike> => {
    const getSandbox = providerOptions.getSandbox
      ?? (await import("@cloudflare/sandbox")).getSandbox as unknown as GetCloudflareSandbox;
    return getCodevilSandbox(getSandbox, providerOptions.binding, sandboxId) as CloudflareSandboxLike;
  };

  return {
    name: "cloudflare",
    capabilities: { pauseResume: false, workspaceCache: true },
    async create({ sessionId }) {
      const sandbox = await lookup(sessionId);
      await retrySandboxOperation(() =>
        setCodevilSandboxKeepAlive(sandbox, true, "session provisioning"),
      );
      return cloudflareHandle(sandbox, { provider: "cloudflare", id: sessionId });
    },
    async connect(ref: SandboxRef) {
      return cloudflareHandle(await lookup(ref.id), ref);
    },
  };
}

function cloudflareHandle(sandbox: CloudflareSandboxLike, ref: SandboxRef): SandboxHandle {
  const exec: SandboxHandle["exec"] = async (command, options) => {
    const result = await sandbox.exec(command, {
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    } satisfies ShellResult;
  };

  return {
    ref,
    exec,
    async writeFile(path, content, options) {
      await sandbox.writeFile(path, content);
      const steps: string[] = [];
      if (options?.mode !== undefined) steps.push(`chmod ${options.mode.toString(8)} ${shellQuote(path)}`);
      if (options?.owner !== undefined) steps.push(`chown ${OWNER_IDS[options.owner]} ${shellQuote(path)}`);
      if (steps.length > 0) {
        const result = await exec(steps.join(" && "));
        if (result.exitCode !== 0) {
          throw new Error(`Failed to set permissions on ${path} (exit ${result.exitCode}): ${result.stderr}`);
        }
      }
    },
    async startProcess(command, { processId, cwd, env }) {
      await retrySandboxOperation(() =>
        sandbox.startProcess(command, { cwd, env, processId, autoCleanup: true }),
      );
    },
    readProcessLogs: (processId) => sandbox.getProcessLogs(processId),
    async readLifecycle() {
      return (await sandbox.getCodevilLifecycleSnapshot?.()) ?? null;
    },
    fetchPort(port, request) {
      const headers = new Headers(request.headers);
      headers.set("cf-container-target-port", String(port));
      return sandbox.fetch(new Request(request, { headers }));
    },
    async renewLease() {
      // Cloudflare keepAlive replaces timed leases.
    },
    async destroy(reason) {
      await setCodevilSandboxKeepAlive(sandbox, false, reason);
      await sandbox.stop();
    },
    workspaceCache: sandbox,
  };
}
