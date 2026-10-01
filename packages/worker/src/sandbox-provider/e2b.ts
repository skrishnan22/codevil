import {
  SandboxNotFoundError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRef,
  type ShellResult,
} from "./types.js";

export const E2B_TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";

const LOG_DIR = "/var/log/codevil";
const LOG_TAIL_BYTES = 65_536;
const PROCESS_ID_PATTERN = /^[a-z0-9-]+$/;
const OWNER_IDS = { codevil: "10001:10001", root: "0:0" } as const;

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
    run(command: string, options: E2BRunOptions & { background: true }): Promise<unknown>;
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
        await sandbox.kill().catch(() => undefined);
        throw new Error("E2B sandbox was created without a traffic access token");
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
      try {
        await sandbox.files.write(path, content, { user: "root" });
      } catch (error) {
        throw mapNotFound(sdk, error);
      }
      const steps: string[] = [];
      if (fileOptions?.mode !== undefined) steps.push(`chmod ${fileOptions.mode.toString(8)} ${shellQuote(path)}`);
      if (fileOptions?.owner !== undefined) steps.push(`chown ${OWNER_IDS[fileOptions.owner]} ${shellQuote(path)}`);
      if (steps.length > 0) {
        const result = await exec(steps.join(" && "));
        if (result.exitCode !== 0) {
          throw new Error(`Failed to set permissions on ${path} (exit ${result.exitCode}): ${result.stderr}`);
        }
      }
    },
    async startProcess(command, { processId, cwd, env }) {
      assertProcessId(processId);
      const mkdir = await exec(`mkdir -p ${LOG_DIR}`);
      if (mkdir.exitCode !== 0) {
        throw new Error(`Failed to create ${LOG_DIR} (exit ${mkdir.exitCode}): ${mkdir.stderr}`);
      }
      const redirected = `sh -c ${shellQuote(command)} >${LOG_DIR}/${processId}.out 2>${LOG_DIR}/${processId}.err`;
      try {
        await sandbox.commands.run(redirected, { background: true, user: "root", cwd, envs: env });
      } catch (error) {
        throw mapNotFound(sdk, error);
      }
    },
    async readProcessLogs(processId) {
      assertProcessId(processId);
      return {
        stdout: await tail(`${LOG_DIR}/${processId}.out`),
        stderr: await tail(`${LOG_DIR}/${processId}.err`),
      };
    },
    fetchPort(port, request) {
      const url = new URL(request.url);
      const target = `https://${sandbox.getHost(port)}${url.pathname}${url.search}`;
      const headers = new Headers(request.headers);
      headers.delete("host");
      // Overwrites any client-supplied value; without the token E2B answers 403.
      if (context.secret) headers.set(E2B_TRAFFIC_TOKEN_HEADER, context.secret);
      return context.fetchImpl(new Request(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }));
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
