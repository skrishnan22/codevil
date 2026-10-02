import {
  SandboxNotFoundError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRef,
  type ShellResult,
} from "./types.js";
import { OWNER_IDS, shellQuote } from "./shell.js";

export const E2B_TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";

const LOG_DIR = "/var/log/codevil";
const LOG_TAIL_BYTES = 65_536;
const PROCESS_ID_PATTERN = /^[a-z0-9-]+$/;
/**
 * Root-owned staging directory for `writeFile`. It lives on the same tmpfs as
 * `/run/codevil`, so the final `mv` is an atomic rename there. Assumption: the
 * targets Codevil writes (the websocket token) are under `/run`; for a target
 * on another filesystem `mv` degrades to copy-and-delete.
 */
const STAGE_DIR = "/run/.codevil-stage";

interface E2BRunOptions {
  user?: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
}

/** The slice of the E2B SDK's `Sandbox` instance the adapter relies on. */
export interface E2BSdkSandbox {
  sandboxId: string;
  trafficAccessToken?: string;
  getHost(port: number): string;
  commands: {
    run(command: string, options: E2BRunOptions & { background: true }): Promise<{ disconnect(): Promise<void> }>;
    run(command: string, options?: E2BRunOptions): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: { write(path: string, content: string, options?: { user?: string }): Promise<unknown> };
  setTimeout(ms: number): Promise<void>;
  pause(): Promise<unknown>;
  kill(): Promise<unknown>;
}

export interface E2BSdk {
  create(template: string, options: {
    apiKey: string;
    timeoutMs: number;
    network: { allowPublicTraffic: false };
    metadata: Record<string, string>;
  }): Promise<E2BSdkSandbox>;
  connect(sandboxId: string, options: { apiKey: string; timeoutMs?: number }): Promise<E2BSdkSandbox>;
  isNotFound(error: unknown): boolean;
}

export interface E2BSandboxProviderOptions {
  apiKey: string;
  templateId: string;
  /** Upper bound for any lease the adapter requests (E2B Hobby allows one hour). */
  maxLeaseMs: number;
  /** Injected in tests; production lazily imports `e2b`. */
  sdk?: E2BSdk;
  fetch?: typeof fetch;
}

export function createE2BSandboxProvider(options: E2BSandboxProviderOptions): SandboxProvider {
  const sdk = options.sdk ?? lazyE2BSdk();
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const cap = (ms: number) => Math.min(ms, options.maxLeaseMs);

  return {
    name: "e2b",
    capabilities: { pauseResume: true, workspaceCache: false },
    async create({ sessionId, leaseMs }) {
      // `secure` is ignored in e2b 2.x and a top-level `allowPublicTraffic`
      // is not honored: only `network.allowPublicTraffic` locks the sandbox.
      const sandbox = await sdk.create(options.templateId, {
        apiKey: options.apiKey,
        timeoutMs: cap(leaseMs),
        network: { allowPublicTraffic: false },
        metadata: { codevil_session_id: sessionId },
      });
      if (!sandbox.trafficAccessToken) {
        // Without a token the sandbox may be publicly reachable; never use it.
        const cleanupFailed = await sandbox.kill().then(() => false, () => true);
        throw new Error(
          `E2B sandbox was created without a traffic access token${cleanupFailed ? " (cleanup kill also failed)" : ""}`,
        );
      }
      return e2bHandle({
        sandbox,
        ref: { provider: "e2b", id: sandbox.sandboxId },
        secret: sandbox.trafficAccessToken,
        sdk,
        cap,
        fetchImpl,
      });
    },
    async connect(ref: SandboxRef, connectOptions) {
      let sandbox: E2BSdkSandbox;
      try {
        sandbox = await sdk.connect(ref.id, {
          apiKey: options.apiKey,
          ...(connectOptions?.leaseMs !== undefined ? { timeoutMs: cap(connectOptions.leaseMs) } : {}),
        });
      } catch (error) {
        throw mapNotFound(sdk, error);
      }
      const secret = connectOptions?.secret ?? sandbox.trafficAccessToken;
      return e2bHandle({ sandbox, ref, ...(secret ? { secret } : {}), sdk, cap, fetchImpl });
    },
  };
}

function e2bHandle(context: {
  sandbox: E2BSdkSandbox;
  ref: SandboxRef;
  secret?: string;
  sdk: E2BSdk;
  cap: (ms: number) => number;
  fetchImpl: typeof fetch;
}): SandboxHandle {
  const { sandbox, sdk } = context;

  const exec: SandboxHandle["exec"] = async (command, execOptions) => {
    try {
      const result = await sandbox.commands.run(command, {
        ...(execOptions?.cwd !== undefined ? { cwd: execOptions.cwd } : {}),
        ...(execOptions?.env !== undefined ? { envs: execOptions.env } : {}),
        ...(execOptions?.timeoutMs !== undefined ? { timeoutMs: execOptions.timeoutMs } : {}),
        user: execOptions?.user === "codevil" ? "codevil" : "root",
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } satisfies ShellResult;
    } catch (error) {
      const exit = asCommandExit(error);
      if (exit) return exit;
      throw mapNotFound(sdk, error);
    }
  };

  // `path` is built from a validated process id, so it needs no quoting.
  const tail = async (path: string): Promise<string> =>
    (await exec(`tail -c ${LOG_TAIL_BYTES} ${path} 2>/dev/null || true`)).stdout;

  return {
    ref: context.ref,
    ...(context.secret ? { secret: context.secret } : {}),
    exec,
    async writeFile(path, content, fileOptions) {
      // Content is staged in a root-only directory, permissioned there, then
      // renamed into place: `mv -fT` replaces a symlink at the target instead of
      // following it, and the file is never visible with default permissions.
      const stage = `${STAGE_DIR}/${crypto.randomUUID()}`;
      const prepare = await exec(
        `mkdir -p -m 700 ${STAGE_DIR} && chmod 700 ${STAGE_DIR} && chown 0:0 ${STAGE_DIR}`,
      );
      assertOk(prepare, `Failed to prepare staging for ${path}`);
      try {
        try {
          await sandbox.files.write(stage, content, { user: "root" });
        } catch (error) {
          throw mapNotFound(sdk, error);
        }
        const steps: string[] = [];
        if (fileOptions?.mode !== undefined) steps.push(`chmod ${fileOptions.mode.toString(8)} ${shellQuote(stage)}`);
        if (fileOptions?.owner !== undefined) steps.push(`chown ${OWNER_IDS[fileOptions.owner]} ${shellQuote(stage)}`);
        steps.push(`mkdir -p ${shellQuote(parentDirectory(path))}`);
        steps.push(`mv -fT ${shellQuote(stage)} ${shellQuote(path)}`);
        assertOk(await exec(steps.join(" && ")), `Failed to write ${path}`);
      } catch (error) {
        // Non-zero exit or transport failure: never leave staged content behind.
        await exec(`rm -f ${shellQuote(stage)}`).catch(() => undefined);
        throw error;
      }
    },
    async startProcess(command, { processId, cwd, env }) {
      assertProcessId(processId);
      const mkdir = await exec(`mkdir -p ${LOG_DIR}`);
      if (mkdir.exitCode !== 0) {
        throw new Error(`Failed to create ${LOG_DIR} (exit ${mkdir.exitCode}): ${mkdir.stderr}`);
      }
      const redirected = `sh -c ${shellQuote(command)} >${LOG_DIR}/${processId}.out 2>${LOG_DIR}/${processId}.err`;
      let handle: { disconnect(): Promise<void> };
      try {
        handle = await sandbox.commands.run(redirected, { background: true, user: "root", cwd, envs: env });
      } catch (error) {
        throw mapNotFound(sdk, error);
      }
      // Closes the SDK's event stream so the Durable Object is not kept resident.
      // The process is already running, so a failure here must not fail
      // startProcess: a retry would start a duplicate agent.
      await handle.disconnect().catch(() => undefined);
    },
    async readProcessLogs(processId) {
      assertProcessId(processId);
      return {
        stdout: await tail(`${LOG_DIR}/${processId}.out`),
        stderr: await tail(`${LOG_DIR}/${processId}.err`),
      };
    },
    async fetchPort(port, request) {
      const url = new URL(request.url);
      const target = `https://${sandbox.getHost(port)}${url.pathname}${url.search}`;
      const headers = new Headers(request.headers);
      headers.delete("host");
      // Never forward a client-supplied token, and never send tokenless: E2B
      // would answer 403 at best.
      headers.delete(E2B_TRAFFIC_TOKEN_HEADER);
      if (!context.secret) throw new Error("E2B sandbox traffic token is unavailable");
      headers.set(E2B_TRAFFIC_TOKEN_HEADER, context.secret);
      const init: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: request.signal,
        ...(request.cf ? { cf: request.cf } : {}),
        ...(request.body ? { duplex: "half" as const } : {}),
      };
      return context.fetchImpl(new Request(target, init));
    },
    async renewLease(ms) {
      try {
        await sandbox.setTimeout(context.cap(ms));
      } catch (error) {
        throw mapNotFound(sdk, error);
      }
    },
    async pause() {
      try {
        await sandbox.pause();
      } catch (error) {
        throw mapNotFound(sdk, error);
      }
    },
    async destroy() {
      try {
        await sandbox.kill();
      } catch (error) {
        if (!sdk.isNotFound(error)) throw error;
      }
    },
  };
}

/** A non-zero exit surfaces from the SDK as a thrown `CommandExitError`; callers expect a result. */
function asCommandExit(error: unknown): ShellResult | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
  if (typeof candidate.exitCode !== "number") return null;
  return {
    stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
    stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
    exitCode: candidate.exitCode,
  };
}

function mapNotFound(sdk: E2BSdk, error: unknown): unknown {
  return sdk.isNotFound(error) ? new SandboxNotFoundError("E2B sandbox not found") : error;
}

function assertProcessId(processId: string): void {
  if (!PROCESS_ID_PATTERN.test(processId)) throw new Error("Invalid process id");
}

function assertOk(result: ShellResult, message: string): void {
  if (result.exitCode !== 0) throw new Error(`${message} (exit ${result.exitCode}): ${result.stderr}`);
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** Loads `e2b` on first use so Cloudflare-only paths and tests never pay for the SDK. */
function lazyE2BSdk(): E2BSdk {
  let notFoundClass: (new (...args: never[]) => Error) | undefined;
  let loaded: Promise<typeof import("e2b")> | undefined;
  const load = () => (loaded ??= import("e2b").then((module) => {
    notFoundClass = module.NotFoundError;
    return module;
  }));
  return {
    async create(template, createOptions) {
      const { Sandbox } = await load();
      return (await Sandbox.create(template, createOptions)) as unknown as E2BSdkSandbox;
    },
    async connect(sandboxId, connectOptions) {
      const { Sandbox } = await load();
      return (await Sandbox.connect(sandboxId, connectOptions)) as unknown as E2BSdkSandbox;
    },
    // Synchronous by contract: any error the SDK can throw implies it is already loaded.
    isNotFound: (error) => notFoundClass !== undefined && error instanceof notFoundClass,
  };
}
