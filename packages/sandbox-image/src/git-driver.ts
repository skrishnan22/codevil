import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { normalizeGitHubRepoName } from "@codevil/shared";

import type { GitDriver, PushBranchOptions } from "./runtime.js";

export const DEFAULT_GIT_AUTHOR_NAME = "Codevil Coder";
export const DEFAULT_GIT_AUTHOR_EMAIL = "coder@codevil.com";

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;

export async function configureDefaultGitIdentity(): Promise<void> {
  await run("git", ["config", "--global", "user.name", DEFAULT_GIT_AUTHOR_NAME]);
  await run("git", ["config", "--global", "user.email", DEFAULT_GIT_AUTHOR_EMAIL]);
}

export class ShellGitDriver implements GitDriver {
  private readonly proxyBase?: string;
  private readonly proxySessionId?: string;
  private gitProxyCapability?: string;

  constructor(options: { proxyBase?: string; proxySessionId?: string; gitProxyCapability?: string } = {}) {
    this.proxyBase = options.proxyBase;
    this.proxySessionId = options.proxySessionId;
    this.gitProxyCapability = options.gitProxyCapability;
  }

  refreshGitProxyCapability(capability: string | undefined): void { this.gitProxyCapability = capability; }

  async clone(
    repo: string,
    destination: string,
    onProgress: (line: string) => void,
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const target = this.proxyUrl(repo);
    await run("git", this.withProxyHeader(shallowCloneArgs(target, destination)), {
      onStderr: onProgress,
    });
  }

  async refresh(
    repo: string,
    cwd: string,
    onProgress: (line: string) => void,
    cleanExcludes: string[] = [],
  ): Promise<void> {
    const fetchUrl = this.proxyUrl(repo);
    await run("git", ["remote", "set-url", "origin", fetchUrl], { cwd });
    await run("git", this.withProxyHeader(["fetch", "--progress", "--depth", "1", "--prune", "--no-tags", "origin"]), {
      cwd,
      onStderr: onProgress,
    });
    await run("git", this.withProxyHeader(["remote", "set-head", "origin", "--auto"]), {
      cwd,
      onStderr: onProgress,
    });
    await run("git", ["reset", "--hard", "refs/remotes/origin/HEAD"], { cwd, onStdout: onProgress });
    await run("git", gitCleanArgs(cleanExcludes), { cwd, onStdout: onProgress });
  }

  async defaultBranch(cwd: string): Promise<string> {
    const result = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
    return result.stdout.trim().replace(/^origin\//, "") || "main";
  }

  async pushBranch(options: PushBranchOptions): Promise<void> {
    await run("git", ["checkout", "-b", options.branch], { cwd: options.cwd });
    await run("git", ["add", "-A"], { cwd: options.cwd });
    await run("git", ["commit", "-m", options.commitMessage], { cwd: options.cwd });
    await run("git", this.withProxyHeader(["push", "-u", "origin", options.branch]), { cwd: options.cwd });
  }

  private proxyUrl(repo: string): string {
    if (!this.hasProxyConfiguration()) return repo;
    this.assertCompleteProxyConfiguration();

    const normalized = normalizeGitHubRepoName(repo);
    if (!normalized) {
      throw new Error("Git proxy only permits canonical GitHub repository URLs");
    }
    const [owner, name] = normalized.split("/");
    return new URL(
      `/sandbox-proxy/sessions/${encodeURIComponent(this.proxySessionId!)}/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`,
      this.proxyBase!,
    ).toString();
  }

  private withProxyHeader(args: string[]): string[] {
    if (!this.hasProxyConfiguration()) return args;
    this.assertCompleteProxyConfiguration();
    return ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${this.gitProxyCapability!}`).toString("base64")}`, ...args];
  }

  private hasProxyConfiguration(): boolean {
    return Boolean(this.proxyBase || this.proxySessionId || this.gitProxyCapability);
  }

  private assertCompleteProxyConfiguration(): void {
    if (!this.proxyBase || !this.proxySessionId || !this.gitProxyCapability) {
      throw new Error("Git proxy configuration is incomplete");
    }
  }
}

export function shallowCloneArgs(repo: string, destination: string): string[] {
  return ["clone", "--progress", "--depth", "1", "--no-tags", repo, destination];
}

export function gitCleanArgs(excludes: string[] = []): string[] {
  return [
    "clean",
    "-fdx",
    ...excludes.flatMap((pattern) => ["-e", pattern]),
  ];
}

interface RunOptions {
  cwd?: string;
  onStdout?(line: string): void;
  onStderr?(line: string): void;
  timeoutMs?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

export function runGitCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run(command, args, options);
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have already exited.
        }
      }
      killTimer = setTimeout(() => {
        if (child.pid) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may have already exited.
          }
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      emitLines(chunk, options.onStdout);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      emitLines(chunk, options.onStderr);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`));
      }
    });
  });
}

function emitLines(chunk: string, listener: ((line: string) => void) | undefined): void {
  if (!listener) return;
  for (const line of chunk.split(/\r?\n/)) {
    if (line.trim()) listener(line);
  }
}
