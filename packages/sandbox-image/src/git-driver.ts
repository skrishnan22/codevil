import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import type { CreatePullRequestOptions, GitDriver } from "./runtime.js";

export class ShellGitDriver implements GitDriver {
  async clone(
    repo: string,
    destination: string,
    onProgress: (line: string) => void,
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await run("git", ["clone", "--progress", repo, destination], {
      onStderr: onProgress,
    });
  }

  async defaultBranch(cwd: string): Promise<string> {
    const result = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
    return result.stdout.trim().replace(/^origin\//, "") || "main";
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<string> {
    await run("git", ["checkout", "-b", options.branch], { cwd: options.cwd });
    await run("git", ["add", "-A"], { cwd: options.cwd });
    await run("git", ["commit", "-m", options.commitMessage], { cwd: options.cwd });
    await run("git", ["push", "-u", "origin", options.branch], { cwd: options.cwd });

    const result = await run("gh", [
      "pr",
      "create",
      "--draft",
      "--base",
      options.baseBranch,
      "--title",
      options.prTitle,
      "--body",
      options.prBody,
    ], { cwd: options.cwd });

    return result.stdout.trim();
  }
}

interface RunOptions {
  cwd?: string;
  onStdout?(line: string): void;
  onStderr?(line: string): void;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

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

    child.on("error", reject);
    child.on("close", (code) => {
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
