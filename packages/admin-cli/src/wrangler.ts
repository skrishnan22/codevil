import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const wranglerPrefix = ["--filter", "@codevil/worker", "exec", "wrangler"] as const;

export interface WranglerClient {
  whoami(): Promise<void>;
  configuredSecrets(): Promise<Set<string>>;
  uploadSecrets(secrets: Record<string, string>): Promise<void>;
}

export type ExecRequest = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExecFunction = (request: ExecRequest) => Promise<ExecResult>;

const WRANGLER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "COMSPEC",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "WRANGLER_LOG",
  "WRANGLER_LOG_PATH",
  "CI",
] as const;

export function createWranglerClient(options: { exec?: ExecFunction } = {}): WranglerClient {
  const exec = options.exec ?? execProcess;

  return {
    async whoami() {
      await runWrangler(exec, ["whoami", "--json"], {
        failurePrefix: "wrangler whoami failed",
      });
    },

    async configuredSecrets() {
      const { stdout, stderr } = await runWrangler(exec, ["secret", "list", "--format", "json"], {
        failurePrefix: "wrangler secret list failed",
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        throw new Error(
          formatFailure(
            "Unable to parse configured wrangler secrets.",
            { stdout, stderr },
            error,
          ),
        );
      }

      if (!Array.isArray(parsed)) {
        throw new Error(
          formatFailure(
            "Unable to parse configured wrangler secrets.",
            { stdout, stderr },
          ),
        );
      }

      const names = new Set<string>();
      for (const item of parsed) {
        if (typeof item === "string") {
          names.add(item);
          continue;
        }

        if (item && typeof item === "object" && typeof item.name === "string") {
          names.add(item.name);
          continue;
        }

        throw new Error(
          formatFailure(
            "Unable to parse configured wrangler secrets.",
            { stdout, stderr },
          ),
        );
      }

      return names;
    },

    async uploadSecrets(secrets) {
      const redactions = Object.values(secrets).filter((value) => value.length > 0);

      await runWrangler(
        exec,
        ["secret", "bulk"],
        {
          failurePrefix: "wrangler secret bulk failed",
          stdin: JSON.stringify(secrets),
          redactValues: redactions,
        },
      );
    },
  };
}

async function runWrangler(
  exec: ExecFunction,
  args: string[],
  options: {
    failurePrefix: string;
    stdin?: string;
    redactValues?: string[];
  },
) {
  const request: ExecRequest = {
    command: "pnpm",
    args: [...wranglerPrefix, ...args],
    cwd: repoRoot,
    stdin: options.stdin,
    env: buildWranglerEnv(process.env),
  };

  let result: ExecResult;
  try {
    result = await exec(request);
  } catch (error) {
    throw new Error(
      formatFailure(
        options.failurePrefix,
        { stdout: "", stderr: "" },
        error,
        options.redactValues,
      ),
    );
  }

  if (result.exitCode !== 0) {
    throw new Error(
      formatFailure(
        options.failurePrefix,
        result,
        undefined,
        options.redactValues,
      ),
    );
  }

  return result;
}

export function buildWranglerEnv(
  source: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  if (!source) {
    return env;
  }

  for (const key of WRANGLER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

function formatFailure(
  prefix: string,
  result: { stdout: string; stderr: string },
  error?: unknown,
  redactValues: readonly string[] = [],
) {
  const details = [
    sanitize(result.stderr, redactValues),
    sanitize(result.stdout, redactValues),
    sanitize(error instanceof Error ? error.message : undefined, redactValues),
  ].filter((value) => value && value.length > 0);

  return details.length > 0 ? `${prefix}: ${details.join(" | ")}` : prefix;
}

function sanitize(value: string | undefined, redactValues: readonly string[]) {
  if (!value) {
    return value;
  }

  let sanitized = value;
  for (const redactValue of redactValues) {
    if (redactValue.length === 0) {
      continue;
    }

    sanitized = sanitized.split(redactValue).join("[REDACTED]");
  }
  return sanitized;
}

async function execProcess(request: ExecRequest): Promise<ExecResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });

    if (typeof request.stdin === "string") {
      child.stdin.end(request.stdin);
      return;
    }

    child.stdin.end();
  });
}
