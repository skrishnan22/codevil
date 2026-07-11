import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { normalizeGitHubRepoName } from "@codevil/shared";

import type { GitDriver, PushBranchOptions } from "./runtime.js";

export const DEFAULT_GIT_AUTHOR_NAME = "Codevil Coder";
export const DEFAULT_GIT_AUTHOR_EMAIL = "coder@codevil.com";

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;
const GIT_PROXY_DIRECTORY = ".codevil";
const GIT_PROXY_HELPER = "git-proxy-credential-helper.cjs";
const GIT_PROXY_CONFIG = "git-proxy-credential.json";
const GIT_PROXY_TOKEN = "git-proxy-capability";

interface GitProxyOptions {
  proxyBase: string;
  proxySessionId: string;
  gitProxyCapability: string;
}

/**
 * Configure Git's normal credential path for the sandbox proxy. The capability
 * itself lives only in a mode-0600 file, never in a URL, command line, or Git
 * config. The helper is deliberately installed globally because coding agents
 * run Git themselves rather than through ShellGitDriver.
 */
export async function configureGitProxyCredentials(options: GitProxyOptions): Promise<void> {
  const directory = join(sandboxHome(), GIT_PROXY_DIRECTORY);
  const helperPath = join(directory, GIT_PROXY_HELPER);
  const configPath = join(directory, GIT_PROXY_CONFIG);
  const tokenPath = join(directory, GIT_PROXY_TOKEN);
  const proxy = new URL(options.proxyBase);
  const routePrefix = `/sandbox-proxy/sessions/${encodeURIComponent(options.proxySessionId)}/github/`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeAtomic(helperPath, GIT_PROXY_CREDENTIAL_HELPER, 0o700);
  await writeAtomic(configPath, JSON.stringify({ host: proxy.host, routePrefix, tokenPath }), 0o600);
  await writeAtomic(tokenPath, options.gitProxyCapability, 0o600);

  // Git only supplies a repository path to helpers when this is enabled. The
  // helper then rejects every non-proxy host and every path outside this session.
  await run("git", ["config", "--global", "credential.useHttpPath", "true"]);
  await run("git", ["config", "--global", "--replace-all", "credential.helper", helperPath]);

  // This covers Git commands initiated by the agent (for example, cloning
  // supplementary GitHub context), while ShellGitDriver continues to persist
  // the explicit proxy route as origin for the primary checkout.
  const proxyPrefix = new URL(routePrefix, options.proxyBase).toString();
  await run("git", ["config", "--global", "--replace-all", `url.${proxyPrefix}.insteadOf`, "https://github.com/"]);
  await run("git", ["config", "--global", "--add", `url.${proxyPrefix}.insteadOf`, "git@github.com:"]);
  await run("git", ["config", "--global", "--add", `url.${proxyPrefix}.insteadOf`, "ssh://git@github.com/"]);
}

export async function updateGitProxyCapability(capability: string | undefined): Promise<void> {
  const tokenPath = join(sandboxHome(), GIT_PROXY_DIRECTORY, GIT_PROXY_TOKEN);
  if (!capability) {
    await rm(tokenPath, { force: true });
    return;
  }
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  await writeAtomic(tokenPath, capability, 0o600);
}

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

  async refreshGitProxyCapability(capability: string | undefined): Promise<void> {
    this.gitProxyCapability = capability;
    if (this.proxyBase && this.proxySessionId) await updateGitProxyCapability(capability);
  }

  async clone(
    repo: string,
    destination: string,
    onProgress: (line: string) => void,
  ): Promise<void> {
    await this.ensureProxyGitCredentials();
    await mkdir(dirname(destination), { recursive: true });
    const target = this.proxyUrl(repo);
    await run("git", shallowCloneArgs(target, destination), {
      onStderr: onProgress,
    });
  }

  async refresh(
    repo: string,
    cwd: string,
    onProgress: (line: string) => void,
    cleanExcludes: string[] = [],
  ): Promise<void> {
    await this.ensureProxyGitCredentials();
    const fetchUrl = this.proxyUrl(repo);
    await run("git", ["remote", "set-url", "origin", fetchUrl], { cwd });
    await run("git", ["fetch", "--progress", "--depth", "1", "--prune", "--no-tags", "origin"], {
      cwd,
      onStderr: onProgress,
    });
    await run("git", ["remote", "set-head", "origin", "--auto"], {
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
    await this.ensureProxyGitCredentials();
    await run("git", ["checkout", "-b", options.branch], { cwd: options.cwd });
    await run("git", ["add", "-A"], { cwd: options.cwd });
    await run("git", ["commit", "-m", options.commitMessage], { cwd: options.cwd });
    await run("git", ["push", "-u", "origin", options.branch], { cwd: options.cwd });
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

  private async ensureProxyGitCredentials(): Promise<void> {
    if (!this.hasProxyConfiguration()) return;
    this.assertCompleteProxyConfiguration();
    await configureGitProxyCredentials({
      proxyBase: this.proxyBase!,
      proxySessionId: this.proxySessionId!,
      gitProxyCapability: this.gitProxyCapability!,
    });
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

function sandboxHome(): string {
  return process.env.HOME || "/home/codevil";
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

// Kept as plain CommonJS so it can be executed by Git independently of the
// sandbox runtime. It only responds to a complete, session-scoped proxy route.
const GIT_PROXY_CREDENTIAL_HELPER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME || "/home/codevil";
const configPath = path.join(home, ".codevil", "git-proxy-credential.json");
let config;
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fields = Object.fromEntries(input.split(/\\r?\\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("="); return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
  const repo = "[A-Za-z0-9_.-]+";
  // Git's insteadOf rewriting replaces a prefix and cannot append a git suffix.
  // The Worker accepts this exact bare repository spelling and canonicalizes
  // it to a git suffix; all other paths remain rejected here and by the Worker.
  const route = new RegExp("^" + config.routePrefix.replace(/^\\//, "").replace(/[.*+?^$()|[\\]\\\\]/g, "\\\\$&") + repo + "/" + repo + "(?:\\\\.git)?(?:/(?:info/refs|git-upload-pack|git-receive-pack))?$");
  const requestPath = (fields.path || "").replace(/^\\//, "");
  if (fields.protocol !== "https" || fields.host !== config.host || !route.test(requestPath)) return;
  let token; try { token = fs.readFileSync(config.tokenPath, "utf8").trim(); } catch { return; }
  if (!token) return;
  process.stdout.write("protocol=https\\nhost=" + fields.host + "\\npath=" + fields.path + "\\nusername=x-access-token\\npassword=" + token + "\\n\\n");
});
`;

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
