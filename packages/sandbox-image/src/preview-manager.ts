import { createServer } from "node:http";
import { connect as connectTcp } from "node:net";
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

export class PreviewManager {
  private state: PreviewState = { state: "idle" };

  constructor(private readonly options: PreviewManagerOptions) {}

  async start(command: PreviewCommand): Promise<void> {
    if (this.state.state === "running" && !this.state.child.killed) {
      if (previewCommandsEqual(this.state.command, command)) {
        this.options.onReady(this.state.command);
        return;
      }
      await this.stop();
    }

    if (this.state.state === "starting") {
      sandboxLogger().log("WARN", "preview_start_ignored", { reason: "already_starting" });
      return;
    }

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
      if (this.state.state !== "idle" && this.state.child === child) {
        this.state = { state: "idle" };
        this.options.onStopped();
      }
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
      if (after.state === "idle" || after.child !== child) return;
      this.state = { state: "running", command, child };
      this.options.onReady(command);
    } catch (error) {
      await this.stop();
      this.options.onError(withRecentLogs(
        error instanceof Error ? error.message : String(error),
        recentLogs,
      ));
    }
  }

  async stop(): Promise<void> {
    if (this.state.state === "idle") {
      this.options.onStopped();
      return;
    }

    const child = this.state.child;
    this.state = { state: "idle" };
    if (child.killed) {
      this.options.onStopped();
      return;
    }

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

    this.options.onStopped();
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
      checkTcp(port).then((ready) => {
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
        setTimeout(poll, 500);
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

function checkTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({
      host: "127.0.0.1",
      port,
      timeout: 1_000,
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
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
