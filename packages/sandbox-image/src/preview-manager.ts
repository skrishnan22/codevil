import { createServer, request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { PreviewApp, PreviewFramework } from "@codevil/shared";

import { sandboxLogException, sandboxLogger } from "./logging.js";
import { detectPackageManager } from "./package-manager.js";
import { PreviewCommandRejectedError, resolvePreviewSpawn } from "./preview-spawn.js";

export interface PreviewCommand {
  command: string;
  port: number;
  cwd?: string;
  readinessTimeoutMs?: number;
}

export interface PreviewManagerOptions {
  cwd: string;
  onStarting(command: PreviewCommand): void;
  onReady(command: PreviewCommand): void;
  onLog?(line: string): void;
  onError(message: string): void;
  onStopped(): void;
  readinessTimeoutMs?: number;
}

type PreviewState =
  | { state: "idle" }
  | { state: "starting"; command: PreviewCommand; child: ChildProcess }
  | { state: "running"; command: PreviewCommand; child: ChildProcess };

const DEFAULT_PREVIEW_READINESS_TIMEOUT_MS = 30_000;
const NEXT_PREVIEW_READINESS_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5_000;
const MAX_PREVIEW_AUTO_RESTARTS = 3;
const HTTP_READINESS_POLL_MS = 500;
const HTTP_READINESS_REQUEST_TIMEOUT_MS = 2_000;

type PreviewStartSource = "user" | "auto-restart";

export class PreviewManager {
  private state: PreviewState = { state: "idle" };
  private autoRestartCount = 0;
  private stopping = false;
  private stopGeneration = 0;

  constructor(private readonly options: PreviewManagerOptions) {}

  async start(
    command: PreviewCommand,
    source: PreviewStartSource = "user",
    restartGeneration?: number,
  ): Promise<void> {
    let startGeneration: number;
    if (source === "auto-restart") {
      if (this.stopping) return;
      if (restartGeneration === undefined || restartGeneration !== this.stopGeneration) return;
      startGeneration = restartGeneration;
    } else {
      this.stopping = false;
      startGeneration = ++this.stopGeneration;
    }

    const aborted = (): boolean => this.stopping || startGeneration !== this.stopGeneration;

    if (this.state.state === "running" && !this.state.child.killed) {
      if (previewCommandsEqual(this.state.command, command)) {
        this.options.onReady(this.state.command);
        return;
      }
      await this.terminateChild();
    }

    if (this.state.state === "starting") {
      // A newer user request owns this lifecycle generation. Reap the old
      // startup before launching the replacement so it cannot become ready
      // after the new command has been selected.
      await this.terminateChild();
    }

    if (aborted()) return;

    this.options.onStarting(command);
    const recentLogs: string[] = [];
    const recordLog = (line: string): void => {
      const normalized = stripAnsi(line).trim();
      if (!normalized) return;
      const clipped = normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
      recentLogs.push(clipped);
      if (recentLogs.length > 10) recentLogs.shift();
      this.options.onLog?.(clipped);
    };

    let spawnSpec: ReturnType<typeof resolvePreviewSpawn>;
    try {
      spawnSpec = resolvePreviewSpawn(command.command);
    } catch (error) {
      const message = error instanceof PreviewCommandRejectedError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      sandboxLogger().log("WARN", "preview_command_rejected", { message, command: command.command });
      this.options.onError(message);
      return;
    }

    if (aborted()) return;

    const child = spawn(spawnSpec.executable, spawnSpec.argv, {
      cwd: resolvePreviewCwd(this.options.cwd, command.cwd),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "0.0.0.0",
        HOSTNAME: "0.0.0.0",
        PORT: String(command.port),
      },
    });
    this.state = { state: "starting", command, child };
    collectLines(child.stdout, recordLog);
    collectLines(child.stderr, recordLog);
    const childError = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    const childExit = new Promise<void>((resolve, reject) => {
      child.once("exit", (code, signal) => {
        const current = this.state;
        if (current.state === "idle" || current.child !== child) {
          resolve();
          return;
        }
        reject(new Error(previewCommandExitMessage(code, signal)));
      });
    });

    child.on("exit", () => {
      // Only react if this child is still the one we're tracking — a later
      // start() may have replaced it.
      if (this.state.state === "idle" || this.state.child !== child) return;

      const wasRunning = this.state.state === "running";
      const crashedCommand = this.state.command;
      this.state = { state: "idle" };

      if (!wasRunning) {
        // The start() await owns startup failure cleanup and emits its single
        // terminal notification through stop().
        return;
      }

      if (!this.stopping && this.autoRestartCount < MAX_PREVIEW_AUTO_RESTARTS) {
        this.autoRestartCount++;
        const restartGeneration = this.stopGeneration;
        sandboxLogger().log("INFO", "preview_auto_restart", {
          attempt: this.autoRestartCount,
          port: crashedCommand.port,
        });
        void this.start(crashedCommand, "auto-restart", restartGeneration);
        return;
      }

      this.autoRestartCount = 0;
      this.options.onStopped();
    });

    try {
      const readinessTimeoutMs =
        command.readinessTimeoutMs ?? this.options.readinessTimeoutMs ?? DEFAULT_PREVIEW_READINESS_TIMEOUT_MS;
      await Promise.race([
        waitForPortReady(command.port, readinessTimeoutMs),
        childError,
        childExit,
      ]);
      // Re-read after the await: the exit handler may have flipped us to idle.
      // Cast defeats TS narrowing from the assignment above; `this.state` is
      // a mutable class field, so the narrow no longer holds across awaits.
      const after = this.state as PreviewState;
      if (after.state === "idle" || after.child !== child || aborted()) {
        if (after.state !== "idle" && after.child === child) {
          await this.terminateChild();
        }
        return;
      }
      this.state = { state: "running", command, child };
      this.autoRestartCount = 0;
      this.options.onReady(command);
    } catch (error) {
      // A stop or replacement can make a readiness/child failure stale while
      // the await above is in flight. Never let that older operation stop or
      // report an error for the preview that replaced it.
      const current = this.state as PreviewState;
      if (aborted() || (current.state !== "idle" && current.child !== child)) return;

      const failureGeneration = this.stopGeneration;
      await this.stop();
      if (this.stopGeneration !== failureGeneration + 1) return;
      this.options.onError(withRecentLogs(
        error instanceof Error ? error.message : String(error),
        recentLogs,
      ));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const stopGeneration = ++this.stopGeneration;
    this.autoRestartCount = 0;

    if (this.state.state === "idle") {
      if (stopGeneration === this.stopGeneration) this.options.onStopped();
      return;
    }

    await this.terminateChild();
    // A new user start may have begun while the old child was being reaped.
    // In that case its generation owns lifecycle notifications.
    const current = this.state as PreviewState;
    if (stopGeneration === this.stopGeneration && current.state === "idle") {
      this.options.onStopped();
    }
  }

  private async terminateChild(): Promise<void> {
    if (this.state.state === "idle") return;

    const child = this.state.child;
    this.state = { state: "idle" };
    if (child.killed) return;

    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    killPreviewProcessGroup(child, "SIGTERM");

    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
    ]);

    if (child.exitCode === null && child.signalCode === null) {
      killPreviewProcessGroup(child, "SIGKILL");
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
      ]);
    }
  }
}

// --- Detection ---

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

const PACKAGE_SCRIPT_PRIORITY = ["dev", "start", "preview"];
const MAKE_TARGET_PRIORITY = ["dev", "serve", "start", "run"];
const JUST_TARGET_PRIORITY = ["dev", "serve", "start", "run"];

export function detectPreviewApps(root: string): PreviewApp[] {
  const apps: PreviewApp[] = [];
  const workspaceGlobs = readWorkspaceGlobs(root);

  if (workspaceGlobs.length > 0) {
    for (const dir of expandWorkspaceGlobs(root, workspaceGlobs)) {
      const app = detectAppInDirectory(root, dir);
      if (app) apps.push(app);
    }
  } else {
    const rootApp = detectAppInDirectory(root, root);
    if (rootApp) apps.push(rootApp);
  }

  return apps;
}

/**
 * Backward-compatible single-result wrapper kept for legacy callers and tests.
 * Returns the first detected app's command (preferring root over subpackages).
 */
export function detectPreviewCommand(root: string): PreviewCommand | undefined {
  const apps = detectPreviewApps(root);
  if (apps.length === 0) return undefined;
  const first = apps[0];
  return appToCommand(first, root);
}

export function appToCommand(app: PreviewApp, root: string): PreviewCommand {
  const relCwd = relativeCwd(root, app.cwd);
  const command: PreviewCommand = relCwd
    ? { command: app.command, port: app.port, cwd: relCwd }
    : { command: app.command, port: app.port };
  if (app.framework === "next") {
    command.readinessTimeoutMs = NEXT_PREVIEW_READINESS_TIMEOUT_MS;
  }
  return command;
}

function detectAppInDirectory(root: string, dir: string): PreviewApp | undefined {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    const parsed = readPackageJson(packageJsonPath);
    const scripts = parsed.scripts ?? {};
    const scriptName = PACKAGE_SCRIPT_PRIORITY.find((name) => typeof scripts[name] === "string");
    if (scriptName) {
      const scriptValue = scripts[scriptName] ?? "";
      const framework = detectFrameworkFromPackage(parsed, scriptValue);
      const manager = detectPackageManager({
        cwd: dir,
        root,
        declared: parsed.packageManager,
        fallback: "npm",
      }) ?? "npm";
      const port = portForFramework(framework);
      return {
        key: keyFromDir(root, dir, parsed.name),
        name: parsed.name ?? basename(dir),
        cwd: dir,
        framework,
        command: packageScriptCommand(manager, scriptName, framework, port),
        port,
      };
    }
  }

  const makefile = join(dir, "Makefile");
  if (existsSync(makefile)) {
    const target = detectTarget(makefile, MAKE_TARGET_PRIORITY);
    if (target) {
      return {
        key: keyFromDir(root, dir),
        name: basename(dir),
        cwd: dir,
        framework: "make",
        command: `make ${target}`,
        port: 8080,
      };
    }
  }

  const justfile = join(dir, "justfile");
  if (existsSync(justfile)) {
    const target = detectTarget(justfile, JUST_TARGET_PRIORITY);
    if (target) {
      return {
        key: keyFromDir(root, dir),
        name: basename(dir),
        cwd: dir,
        framework: "just",
        command: `just ${target}`,
        port: 8080,
      };
    }
  }

  if (existsSync(join(dir, "manage.py"))) {
    return {
      key: keyFromDir(root, dir),
      name: basename(dir),
      cwd: dir,
      framework: "django",
      command: "python manage.py runserver 0.0.0.0:8000",
      port: 8000,
    };
  }

  if (existsSync(join(dir, "bin", "rails")) || existsSync(join(dir, "config.ru"))) {
    return {
      key: keyFromDir(root, dir),
      name: basename(dir),
      cwd: dir,
      framework: "rails",
      command: "bin/rails server -b 0.0.0.0 -p 3001",
      port: 3001,
    };
  }

  return undefined;
}

function detectFrameworkFromPackage(parsed: PackageJson, scriptValue: string): PreviewFramework {
  if (/\bnext\b/i.test(scriptValue) || hasDependency(parsed, "next")) return "next";
  if (/\bvite\b/i.test(scriptValue) || hasDependency(parsed, "vite")) return "vite";
  if (/react-scripts/i.test(scriptValue) || hasDependency(parsed, "react-scripts")) return "react-scripts";
  return "npm";
}

function portForFramework(framework: PreviewFramework): number {
  switch (framework) {
    case "next":
      return 3001;
    case "vite":
      return 5173;
    case "react-scripts":
      return 3001;
    case "django":
      return 8000;
    case "rails":
      return 3001;
    case "make":
    case "just":
    case "npm":
      return 8080;
  }
}

function packageScriptCommand(
  manager: "pnpm" | "npm" | "yarn" | "bun",
  scriptName: string,
  framework: PreviewFramework,
  port: number,
): string {
  const base = manager === "npm" ? `npm run ${scriptName}` : `${manager} ${scriptName}`;
  switch (framework) {
    case "next":
      return `${base} -- --hostname 0.0.0.0 --port ${port}`;
    case "vite":
      return `${base} -- --host 0.0.0.0 --port ${port}`;
    case "react-scripts":
    case "npm":
      return base;
  }
  return base;
}

function hasDependency(parsed: PackageJson, name: string): boolean {
  return Boolean(parsed.dependencies?.[name] || parsed.devDependencies?.[name]);
}

function readPackageJson(path: string): PackageJson {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

function previewCommandsEqual(a: PreviewCommand, b: PreviewCommand): boolean {
  return a.command === b.command && a.port === b.port && a.cwd === b.cwd;
}

function killPreviewProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  } else {
    child.kill(signal);
  }
}

function detectTarget(path: string, targets: string[]): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  return targets.find((target) => new RegExp(`^${target}:`, "m").test(content));
}

function readWorkspaceGlobs(root: string): string[] {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const parsed = readPackageJson(pkgPath);
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) return workspaces;
    if (workspaces && Array.isArray(workspaces.packages)) return workspaces.packages;
  }

  const pnpmPath = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    return readPnpmWorkspaceGlobs(pnpmPath);
  }

  return [];
}

function readPnpmWorkspaceGlobs(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/);
      if (match) {
        globs.push(match[1]);
        continue;
      }
      if (/^\S/.test(line)) inPackages = false;
    }
  }
  return globs;
}

function expandWorkspaceGlobs(root: string, globs: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const glob of globs) {
    for (const dir of expandSingleGlob(root, glob)) {
      if (!seen.has(dir)) {
        seen.add(dir);
        results.push(dir);
      }
    }
  }
  return results;
}

function expandSingleGlob(root: string, glob: string): string[] {
  // Strip leading "./"
  const cleaned = glob.replace(/^\.\//, "");
  // Only support patterns ending in "/*" or being a literal path
  if (cleaned.endsWith("/*")) {
    const parent = cleaned.slice(0, -2);
    const parentAbs = resolve(root, parent);
    if (!isDirectory(parentAbs)) return [];
    return readdirSync(parentAbs)
      .map((entry) => join(parentAbs, entry))
      .filter((p) => isDirectory(p));
  }
  const literal = resolve(root, cleaned);
  return isDirectory(literal) ? [literal] : [];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function keyFromDir(root: string, dir: string, pkgName?: string): string {
  if (dir === root) return ".";
  const rel = relative(root, dir);
  return rel || pkgName || basename(dir);
}

function relativeCwd(root: string, dir: string): string | undefined {
  if (dir === root) return undefined;
  const rel = relative(root, dir);
  return rel || undefined;
}

function resolvePreviewCwd(root: string, cwd: string | undefined): string {
  if (!cwd || cwd === ".") return root;
  const resolved = resolve(root, cwd);
  const rootWithSeparator = root.endsWith("/") ? root : `${root}/`;
  if (resolved !== root && !resolved.startsWith(rootWithSeparator)) return root;
  return resolved;
}

function waitForPortReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      checkHttp(port).then((ready) => {
        if (ready) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(
            `Preview server did not become healthy on port ${port} within ${formatDuration(timeoutMs)}.`,
          ));
          return;
        }
        setTimeout(poll, HTTP_READINESS_POLL_MS);
      });
    };
    poll();
  });
}

function previewCommandExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `Preview command exited before becoming healthy (code ${code}).`;
  if (signal) return `Preview command exited before becoming healthy (signal ${signal}).`;
  return "Preview command exited before becoming healthy.";
}

function formatDuration(ms: number): string {
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${Number((ms / 1_000).toFixed(2))}s`;
}

function checkHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        timeout: HTTP_READINESS_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status > 0 && status < 500);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function collectLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (!stream) return;

  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (buffered) onLine(buffered);
    buffered = "";
  });
  stream.on("error", (error) => {
    sandboxLogException("preview_stream_error", error);
  });
}

function withRecentLogs(message: string, recentLogs: string[]): string {
  if (recentLogs.length === 0) return message;
  return [
    message,
    "Recent preview output:",
    ...recentLogs.map((line) => `  ${line}`),
  ].join("\n");
}

function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function fakePreviewServer(port: number): Promise<{ close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}
