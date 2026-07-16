import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

import type { SandboxToDOMessage } from "@codevil/shared";
import {
  DEPENDENCY_ARTIFACT_FORMAT_VERSION,
  computeDependencyFingerprint,
  dependencyArtifactsPresent,
  dependencyMarkerMatches,
  detectJavaScriptDependencyStrategy,
  removeDependencyArtifactMarker,
  removeJavaScriptDependencyArtifacts,
  repositoryHasInstallLifecycleScripts,
  writeDependencyArtifactMarker,
  type DependencyArtifactMarker,
  type DependencyFingerprint,
  type JavaScriptDependencyStrategy,
} from "./dependency-cache.js";
import {
  formatCommandFailure,
  outputLines,
} from "./runtime-helpers.js";
import type { CommandRunner } from "./verification.js";

export function dependencyCacheEnv(workspace: string): Record<string, string> {
  return {
    npm_config_cache: join(workspace, "cache", "npm"),
    npm_config_store_dir: join(workspace, "cache", "pnpm-store"),
    YARN_CACHE_FOLDER: join(workspace, "cache", "yarn"),
    BUN_INSTALL_CACHE_DIR: join(workspace, "cache", "bun"),
  };
}

export interface RepoSetupContext {
  workspace: string;
  repoDir: string;
  restoredFromCache: boolean;
  restoredDependencyMarker?: DependencyArtifactMarker;
  commandRunner: CommandRunner;
  send: (message: SandboxToDOMessage) => void;
  maybeSpan<T>(
    name: string,
    options: { attributes?: Record<string, unknown> },
    fn: () => Promise<T> | T,
  ): Promise<T>;
}

export async function setupRepository(ctx: RepoSetupContext): Promise<void> {
  const explicitSetup = existsSync(join(ctx.repoDir, ".codevil", "setup.sh"));
  if (explicitSetup) {
    await removeDependencyArtifactMarker(ctx.workspace);
    await runSetupCommand(ctx, "bash .codevil/setup.sh", "Running explicit setup command");
    return;
  }

  const strategy = detectJavaScriptDependencyStrategy(ctx.repoDir);
  if (!strategy) {
    await removeDependencyArtifactMarker(ctx.workspace);
    return;
  }

  if (repositoryHasInstallLifecycleScripts(ctx.repoDir)) {
    ctx.send({
      type: "status",
      message: "Repository install lifecycle scripts require installation.",
    });
    await removeDependencyArtifactMarker(ctx.workspace);
    if (ctx.restoredFromCache) {
      await removeJavaScriptDependencyArtifacts(ctx.repoDir);
    }
    await runSetupCommand(ctx, strategy.installCommand, "Running setup command");
    return;
  }

  const fingerprint = await tryDependencyFingerprint(ctx, strategy);
  if (
    fingerprint
    && dependencyMarkerMatches(ctx.restoredDependencyMarker, strategy, fingerprint)
    && dependencyArtifactsPresent(ctx.repoDir, strategy)
  ) {
    ctx.send({
      type: "status",
      message: "Reused cached dependencies; install skipped.",
    });
    return;
  }

  ctx.send({
    type: "status",
    message: "Dependency cache unavailable or incompatible; running install.",
  });
  await removeDependencyArtifactMarker(ctx.workspace);
  if (ctx.restoredFromCache) {
    await removeJavaScriptDependencyArtifacts(ctx.repoDir);
  }
  await runSetupCommand(ctx, strategy.installCommand, "Running setup command");

  const installedFingerprint = fingerprint
    ?? await tryDependencyFingerprint(ctx, strategy);
  if (installedFingerprint) {
    await writeDependencyArtifactMarker(ctx.workspace, {
      formatVersion: DEPENDENCY_ARTIFACT_FORMAT_VERSION,
      ecosystem: strategy.ecosystem,
      packageManager: strategy.packageManager,
      installMode: strategy.installMode,
      fingerprint: installedFingerprint.fingerprint,
      inputs: installedFingerprint.inputs,
      createdAt: new Date().toISOString(),
    });
  }
}

async function tryDependencyFingerprint(
  ctx: RepoSetupContext,
  strategy: JavaScriptDependencyStrategy,
): Promise<DependencyFingerprint | undefined> {
  try {
    return await ctx.maybeSpan(
      "sandbox.dependency_fingerprint",
      { attributes: { package_manager: strategy.packageManager } },
      () => computeDependencyFingerprint(ctx.repoDir, strategy),
    );
  } catch (error) {
    ctx.send({
      type: "status",
      message: `Dependency fingerprint unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return undefined;
  }
}

async function runSetupCommand(
  ctx: RepoSetupContext,
  command: string,
  statusPrefix: string,
): Promise<void> {
  await ensureDependencyCacheDirs(ctx.workspace);
  ctx.send({ type: "status", message: `${statusPrefix}: ${command}` });
  const result = await ctx.commandRunner.run(command, {
    cwd: ctx.repoDir,
    timeoutMs: 300_000,
    env: dependencyCacheEnv(ctx.workspace),
    onOutput: (chunk) => {
      for (const line of outputLines(chunk)) {
        ctx.send({ type: "status", message: `Setup output: ${line}` });
      }
    },
  });

  if (result.code !== 0) {
    throw new Error(formatCommandFailure("Setup", command, result));
  }

  ctx.send({ type: "status", message: "Setup completed." });
}

async function ensureDependencyCacheDirs(workspace: string): Promise<void> {
  await Promise.all(Object.values(dependencyCacheEnv(workspace)).map((value) =>
    value.startsWith(workspace) ? mkdir(value, { recursive: true }) : Promise.resolve(),
  ));
}
