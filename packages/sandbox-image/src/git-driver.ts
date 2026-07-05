import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import type { GitCredential, GitDriver, PushBranchOptions } from "./runtime.js";

export const DEFAULT_GIT_AUTHOR_NAME = "Codevil Coder";
export const DEFAULT_GIT_AUTHOR_EMAIL = "coder@codevil.com";

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;

export async function configureDefaultGitIdentity(): Promise<void> {
  await run("git", ["config", "--global", "user.name", DEFAULT_GIT_AUTHOR_NAME]);
  await run("git", ["config", "--global", "user.email", DEFAULT_GIT_AUTHOR_EMAIL]);
}

export class ShellGitDriver implements GitDriver {
  async clone(
    repo: string,
    destination: string,
    onProgress: (line: string) => void,
    credential?: GitCredential,
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await run("git", shallowCloneArgs(credential ? withCredential(repo, credential) : repo, destination), {
      onStderr: onProgress,
    });
    if (credential) {
      await run("git", ["remote", "set-url", "origin", repo], { cwd: destination });
    }
  }

  async refresh(
    repo: string,
    cwd: string,
    onProgress: (line: string) => void,
    credential?: GitCredential,
    cleanExcludes: string[] = [],
  ): Promise<void> {
    const fetchUrl = credential ? withCredential(repo, credential) : repo;
    await run("git", ["remote", "set-url", "origin", fetchUrl], { cwd });
    try {
      await run("git", ["fetch", "--progress", "--depth", "1", "--prune", "--no-tags", "origin"], {
        cwd,
        onStderr: onProgress,
      });
      await run("git", ["remote", "set-head", "origin", "--auto"], { cwd, onStderr: onProgress });
      await run("git", ["reset", "--hard", "refs/remotes/origin/HEAD"], { cwd, onStdout: onProgress });
      await run("git", gitCleanArgs(cleanExcludes), { cwd, onStdout: onProgress });
    } finally {
      if (credential) {
        await run("git", ["remote", "set-url", "origin", repo], { cwd });
      }
    }
  }

  async defaultBranch(cwd: string): Promise<string> {
    const result = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
    return result.stdout.trim().replace(/^origin\//, "") || "main";
  }

  async pushBranch(options: PushBranchOptions): Promise<void> {
    await run("git", ["checkout", "-b", options.branch], { cwd: options.cwd });
    await run("git", ["add", "-A"], { cwd: options.cwd });
    await run("git", ["commit", "-m", options.commitMessage], { cwd: options.cwd });
    if (options.credential) {
      const origin = (await run("git", ["remote", "get-url", "origin"], { cwd: options.cwd })).stdout.trim();
      await run("git", ["push", "-u", withCredential(origin, options.credential), options.branch], { cwd: options.cwd });
      return;
    }

    await run("git", ["push", "-u", "origin", options.branch], { cwd: options.cwd });
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

function withCredential(repo: string, credential: GitCredential): string {
  const url = new URL(repo);
  url.username = credential.username;
  url.password = credential.password;
  return url.toString();
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
