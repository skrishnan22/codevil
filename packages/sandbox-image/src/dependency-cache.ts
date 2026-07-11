import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { detectLibc } from "./runtime-helpers.js";
import { detectPackageManager } from "./package-manager.js";

export const DEPENDENCY_ARTIFACT_FORMAT_VERSION = 1;
export const DEPENDENCY_ARTIFACT_MARKER = "dependency-artifacts.json";

const execFileAsync = promisify(execFile);
const FINGERPRINT_CONFIG_FILES = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "pnpm-workspace.yaml",
] as const;
const SKIPPED_MANIFEST_DIRS = new Set([
  ".git",
  ".yarn",
  "node_modules",
]);
const YARN_ARTIFACT_PATHS = [
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".yarn/cache",
  ".yarn/unplugged",
  ".yarn/install-state.gz",
  ".yarn/build-state.yml",
] as const;
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
]);

export type JavaScriptPackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type JavaScriptInstallMode = "node-modules" | "pnp";

export interface JavaScriptDependencyStrategy {
  ecosystem: "javascript";
  packageManager: JavaScriptPackageManager;
  installMode: JavaScriptInstallMode;
  installCommand: string;
  cleanExcludes: string[];
}

export interface DependencyFingerprint {
  fingerprint: string;
  inputs: string[];
}

export interface DependencyFingerprintRuntime {
  packageManagerVersion?: string;
  nodeVersion?: string;
  nodeAbi?: string;
  platform?: string;
  arch?: string;
  libc?: string;
  formatVersion?: number;
}

export interface DependencyArtifactMarker {
  formatVersion: number;
  ecosystem: string;
  packageManager: string;
  installMode: JavaScriptInstallMode;
  fingerprint: string;
  inputs: string[];
  createdAt: string;
}

export function detectJavaScriptDependencyStrategy(
  repoDir: string,
): JavaScriptDependencyStrategy | undefined {
  const packageManager = detectPackageManager({ cwd: repoDir });
  if (!packageManager) return undefined;

  const installMode = packageManager === "yarn" && usesYarnPnp(repoDir)
    ? "pnp"
    : "node-modules";

  return {
    ecosystem: "javascript",
    packageManager,
    installMode,
    installCommand: installCommand(packageManager),
    cleanExcludes: installMode === "pnp"
      ? yarnPnpCleanExcludes()
      : nodeModulesCleanExcludes(packageManager === "yarn"),
  };
}

export async function computeDependencyFingerprint(
  repoDir: string,
  strategy: JavaScriptDependencyStrategy,
  runtime: DependencyFingerprintRuntime = {},
): Promise<DependencyFingerprint> {
  const inputs = await dependencyInputPaths(repoDir, strategy);
  const packageManagerVersion = runtime.packageManagerVersion
    ?? await resolvePackageManagerVersion(strategy.packageManager);
  const metadata = {
    formatVersion: runtime.formatVersion ?? DEPENDENCY_ARTIFACT_FORMAT_VERSION,
    ecosystem: strategy.ecosystem,
    packageManager: strategy.packageManager,
    packageManagerVersion,
    installMode: strategy.installMode,
    nodeVersion: runtime.nodeVersion ?? process.versions.node,
    nodeAbi: runtime.nodeAbi ?? process.versions.modules ?? "unknown",
    platform: runtime.platform ?? hostPlatform(),
    arch: runtime.arch ?? hostArch(),
    libc: runtime.libc ?? detectLibc() ?? "unknown",
  };

  const hash = createHash("sha256");
  hash.update(JSON.stringify(metadata));
  hash.update("\n");
  for (const input of inputs) {
    const content = await readFile(join(repoDir, ...input.split("/")));
    hash.update(`${input}\0${content.byteLength}\0`);
    hash.update(content);
    hash.update("\n");
  }

  return { fingerprint: hash.digest("hex"), inputs };
}

export function dependencyArtifactMarkerPath(workspace: string): string {
  return join(workspace, "cache", DEPENDENCY_ARTIFACT_MARKER);
}

export async function readDependencyArtifactMarker(
  workspace: string,
): Promise<DependencyArtifactMarker | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(dependencyArtifactMarkerPath(workspace), "utf8"),
    ) as unknown;
    return isDependencyArtifactMarker(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeDependencyArtifactMarker(
  workspace: string,
  marker: DependencyArtifactMarker,
): Promise<void> {
  const path = dependencyArtifactMarkerPath(workspace);
  await mkdir(join(workspace, "cache"), { recursive: true });
  await writeFile(path, `${JSON.stringify(marker)}\n`);
}

export async function removeDependencyArtifactMarker(workspace: string): Promise<void> {
  await rm(dependencyArtifactMarkerPath(workspace), { force: true });
}

export function dependencyCleanExcludesForMarker(
  marker: DependencyArtifactMarker | undefined,
): string[] {
  const strategy = strategyFromMarker(marker);
  return strategy?.cleanExcludes ?? [];
}

export function dependencyMarkerMatches(
  marker: DependencyArtifactMarker | undefined,
  strategy: JavaScriptDependencyStrategy,
  fingerprint: DependencyFingerprint,
): boolean {
  return marker?.formatVersion === DEPENDENCY_ARTIFACT_FORMAT_VERSION
    && marker.ecosystem === strategy.ecosystem
    && marker.packageManager === strategy.packageManager
    && marker.installMode === strategy.installMode
    && marker.fingerprint === fingerprint.fingerprint;
}

export function dependencyArtifactsPresent(
  repoDir: string,
  strategy: JavaScriptDependencyStrategy,
): boolean {
  if (strategy.installMode === "pnp") {
    return existsSync(join(repoDir, ".pnp.cjs"));
  }
  return existsSync(join(repoDir, "node_modules"));
}

export async function removeJavaScriptDependencyArtifacts(repoDir: string): Promise<void> {
  const nodeModules = await findNodeModules(repoDir);
  await Promise.all(nodeModules.map((path) => rm(path, { recursive: true, force: true })));
  await Promise.all(
    YARN_ARTIFACT_PATHS.map((path) =>
      rm(join(repoDir, ...path.split("/")), { recursive: true, force: true })
    ),
  );
}

export function repositoryHasInstallLifecycleScripts(repoDir: string): boolean {
  const pending = [repoDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_MANIFEST_DIRS.has(entry.name)) {
          pending.push(join(current, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name === "package.json") {
        if (packageManifestHasInstallLifecycleScript(join(current, entry.name))) {
          return true;
        }
      }
    }
  }
  return false;
}

function strategyFromMarker(
  marker: DependencyArtifactMarker | undefined,
): JavaScriptDependencyStrategy | undefined {
  if (
    marker?.formatVersion !== DEPENDENCY_ARTIFACT_FORMAT_VERSION
    || marker.ecosystem !== "javascript"
    || (
      marker.packageManager !== "npm"
      && marker.packageManager !== "pnpm"
      && marker.packageManager !== "yarn"
      && marker.packageManager !== "bun"
    )
  ) {
    return undefined;
  }

  const packageManager = marker.packageManager;
  return {
    ecosystem: "javascript",
    packageManager,
    installMode: marker.installMode,
    installCommand: installCommand(packageManager),
    cleanExcludes: marker.installMode === "pnp"
      ? yarnPnpCleanExcludes()
      : nodeModulesCleanExcludes(packageManager === "yarn"),
  };
}

function readPackageManager(packageJson: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
      packageManager?: unknown;
    };
    if (typeof parsed.packageManager !== "string") return undefined;
    return parsed.packageManager.split("@", 1)[0];
  } catch {
    return undefined;
  }
}

function packageManifestHasInstallLifecycleScript(packageJson: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
      scripts?: unknown;
    };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return false;
    return Object.keys(parsed.scripts).some((script) =>
      INSTALL_LIFECYCLE_SCRIPTS.has(script)
    );
  } catch {
    return false;
  }
}

function usesYarnPnp(repoDir: string): boolean {
  if (existsSync(join(repoDir, ".pnp.cjs"))) return true;
  try {
    const yarnConfig = readFileSync(join(repoDir, ".yarnrc.yml"), "utf8");
    return /^\s*nodeLinker\s*:\s*pnp\s*$/m.test(yarnConfig);
  } catch {
    return false;
  }
}

function installCommand(packageManager: JavaScriptPackageManager): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "npm":
      return "npm install --no-audit --no-fund --prefer-offline";
    case "yarn":
      return "yarn install --immutable";
    case "bun":
      return "bun install --frozen-lockfile";
  }
}

function nodeModulesCleanExcludes(includeYarnState: boolean): string[] {
  return [
    "node_modules/",
    "**/node_modules/",
    ...(includeYarnState ? [".yarn/install-state.gz"] : []),
  ];
}

function yarnPnpCleanExcludes(): string[] {
  return [
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".yarn/cache/",
    ".yarn/unplugged/",
    ".yarn/install-state.gz",
    ".yarn/build-state.yml",
  ];
}

async function dependencyInputPaths(
  repoDir: string,
  strategy: JavaScriptDependencyStrategy,
): Promise<string[]> {
  const lockfile = activeLockfile(repoDir, strategy.packageManager);
  if (!lockfile) {
    throw new Error(`No recognized ${strategy.packageManager} lockfile found`);
  }

  const paths = new Set<string>([lockfile]);
  await collectPackageManifests(repoDir, repoDir, paths);
  for (const config of FINGERPRINT_CONFIG_FILES) {
    if (existsSync(join(repoDir, config))) paths.add(config);
  }
  return [...paths].sort();
}

function activeLockfile(
  repoDir: string,
  packageManager: JavaScriptPackageManager,
): string | undefined {
  const candidates: Record<JavaScriptPackageManager, string[]> = {
    npm: ["npm-shrinkwrap.json", "package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    bun: ["bun.lock", "bun.lockb"],
  };
  return candidates[packageManager].find((path) => existsSync(join(repoDir, path)));
}

async function collectPackageManifests(
  root: string,
  current: string,
  paths: Set<string>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_MANIFEST_DIRS.has(entry.name)) continue;
      await collectPackageManifests(root, join(current, entry.name), paths);
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      paths.add(toPosix(relative(root, join(current, entry.name))));
    }
  }
}

async function resolvePackageManagerVersion(
  packageManager: JavaScriptPackageManager,
): Promise<string> {
  const result = await execFileAsync(packageManager, ["--version"]);
  return result.stdout.trim();
}

async function findNodeModules(repoDir: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [repoDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name === "node_modules") {
        found.push(path);
        continue;
      }
      if (entry.name === ".git" || entry.name === ".yarn") continue;
      pending.push(path);
    }
  }
  return found;
}

function isDependencyArtifactMarker(value: unknown): value is DependencyArtifactMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<DependencyArtifactMarker>;
  return typeof marker.formatVersion === "number"
    && typeof marker.ecosystem === "string"
    && typeof marker.packageManager === "string"
    && (marker.installMode === "node-modules" || marker.installMode === "pnp")
    && typeof marker.fingerprint === "string"
    && Array.isArray(marker.inputs)
    && marker.inputs.every((input) => typeof input === "string")
    && typeof marker.createdAt === "string";
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
