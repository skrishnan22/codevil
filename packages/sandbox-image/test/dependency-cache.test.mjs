import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEPENDENCY_ARTIFACT_FORMAT_VERSION,
  computeDependencyFingerprint,
  dependencyArtifactsPresent,
  detectJavaScriptDependencyStrategy,
  readDependencyArtifactMarker,
  removeJavaScriptDependencyArtifacts,
  repositoryHasInstallLifecycleScripts,
  writeDependencyArtifactMarker,
} from "../dist/dependency-cache.js";

const runtime = {
  packageManagerVersion: "10.28.1",
  nodeVersion: "20.19.0",
  nodeAbi: "115",
  platform: "linux",
  arch: "x64",
  libc: "gnu",
};

async function withRepo(fn) {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-dependency-cache-"));
  const repoDir = join(workspace, "repo");
  await mkdir(repoDir, { recursive: true });
  try {
    await fn({ workspace, repoDir });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("detects npm, pnpm, yarn, bun, and Yarn Plug'n'Play strategies", async () => {
  const cases = [
    { lockfile: "package-lock.json", contents: "{}", manager: "npm", mode: "node-modules" },
    { lockfile: "pnpm-lock.yaml", contents: "lockfileVersion: '9.0'\n", manager: "pnpm", mode: "node-modules" },
    { lockfile: "yarn.lock", contents: "", manager: "yarn", mode: "node-modules" },
    { lockfile: "bun.lock", contents: "", manager: "bun", mode: "node-modules" },
  ];

  for (const entry of cases) {
    await withRepo(async ({ repoDir }) => {
      await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "app" }));
      await writeFile(join(repoDir, entry.lockfile), entry.contents);

      const strategy = detectJavaScriptDependencyStrategy(repoDir);
      assert.equal(strategy.packageManager, entry.manager);
      assert.equal(strategy.installMode, entry.mode);
    });
  }

  await withRepo(async ({ repoDir }) => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "app" }));
    await writeFile(join(repoDir, "yarn.lock"), "");
    await writeFile(join(repoDir, ".yarnrc.yml"), "nodeLinker: pnp\n");

    const strategy = detectJavaScriptDependencyStrategy(repoDir);
    assert.equal(strategy.packageManager, "yarn");
    assert.equal(strategy.installMode, "pnp");
  });
});

test("fingerprint is stable across source-only changes and file discovery order", async () => {
  await withRepo(async ({ repoDir }) => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({
      name: "root",
      packageManager: "pnpm@10.28.1",
      workspaces: ["packages/*"],
    }));
    await writeFile(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await mkdir(join(repoDir, "packages", "zeta"), { recursive: true });
    await mkdir(join(repoDir, "packages", "alpha"), { recursive: true });
    await writeFile(join(repoDir, "packages", "zeta", "package.json"), JSON.stringify({ name: "zeta" }));
    await writeFile(join(repoDir, "packages", "alpha", "package.json"), JSON.stringify({ name: "alpha" }));

    const strategy = detectJavaScriptDependencyStrategy(repoDir);
    const first = await computeDependencyFingerprint(repoDir, strategy, runtime);

    await writeFile(join(repoDir, "src.ts"), "export const changed = true;\n");
    const second = await computeDependencyFingerprint(repoDir, strategy, runtime);

    assert.equal(first.fingerprint, second.fingerprint);
    assert.deepEqual(first.inputs, [
      "package.json",
      "packages/alpha/package.json",
      "packages/zeta/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]);
  });
});

test("fingerprint changes for dependency inputs and runtime compatibility", async () => {
  await withRepo(async ({ repoDir }) => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }));
    await writeFile(join(repoDir, "package-lock.json"), "{\"lockfileVersion\":3}");
    const strategy = detectJavaScriptDependencyStrategy(repoDir);
    const base = await computeDependencyFingerprint(repoDir, strategy, runtime);

    const variants = [
      { ...runtime, packageManagerVersion: "11.0.0" },
      { ...runtime, nodeVersion: "22.0.0" },
      { ...runtime, nodeAbi: "127" },
      { ...runtime, platform: "darwin" },
      { ...runtime, arch: "arm64" },
      { ...runtime, libc: "musl" },
      { ...runtime, formatVersion: DEPENDENCY_ARTIFACT_FORMAT_VERSION + 1 },
    ];
    for (const variant of variants) {
      const next = await computeDependencyFingerprint(repoDir, strategy, variant);
      assert.notEqual(base.fingerprint, next.fingerprint);
    }

    await writeFile(join(repoDir, "package-lock.json"), "{\"lockfileVersion\":3,\"changed\":true}");
    assert.notEqual(base.fingerprint, (await computeDependencyFingerprint(repoDir, strategy, runtime)).fingerprint);

    await writeFile(join(repoDir, "package-lock.json"), "{\"lockfileVersion\":3}");
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "app", dependencies: { react: "20.0.0" } }));
    assert.notEqual(base.fingerprint, (await computeDependencyFingerprint(repoDir, strategy, runtime)).fingerprint);
  });
});

test("dependency artifact markers round-trip under the workspace cache", async () => {
  await withRepo(async ({ workspace }) => {
    const marker = {
      formatVersion: DEPENDENCY_ARTIFACT_FORMAT_VERSION,
      ecosystem: "javascript",
      packageManager: "npm",
      installMode: "node-modules",
      fingerprint: "abc123",
      inputs: ["package-lock.json", "package.json"],
      createdAt: "2026-06-25T00:00:00.000Z",
    };

    await writeDependencyArtifactMarker(workspace, marker);

    assert.deepEqual(await readDependencyArtifactMarker(workspace), marker);
    assert.deepEqual(
      JSON.parse(await readFile(join(workspace, "cache", "dependency-artifacts.json"), "utf8")),
      marker,
    );
  });
});

test("validates and removes nested node_modules and Yarn PnP artifacts", async () => {
  await withRepo(async ({ repoDir }) => {
    await mkdir(join(repoDir, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(repoDir, "apps", "web", "node_modules", "react"), { recursive: true });
    await mkdir(join(repoDir, ".yarn", "cache"), { recursive: true });
    await mkdir(join(repoDir, ".yarn", "unplugged"), { recursive: true });
    await writeFile(join(repoDir, ".pnp.cjs"), "module.exports = {};\n");
    await writeFile(join(repoDir, ".yarn", "install-state.gz"), "state");

    assert.equal(dependencyArtifactsPresent(repoDir, {
      ecosystem: "javascript",
      packageManager: "npm",
      installMode: "node-modules",
      installCommand: "npm install",
      cleanExcludes: [],
    }), true);
    assert.equal(dependencyArtifactsPresent(repoDir, {
      ecosystem: "javascript",
      packageManager: "yarn",
      installMode: "pnp",
      installCommand: "yarn install --immutable",
      cleanExcludes: [],
    }), true);

    await removeJavaScriptDependencyArtifacts(repoDir);

    assert.equal(dependencyArtifactsPresent(repoDir, {
      ecosystem: "javascript",
      packageManager: "npm",
      installMode: "node-modules",
      installCommand: "npm install",
      cleanExcludes: [],
    }), false);
    assert.equal(dependencyArtifactsPresent(repoDir, {
      ecosystem: "javascript",
      packageManager: "yarn",
      installMode: "pnp",
      installCommand: "yarn install --immutable",
      cleanExcludes: [],
    }), false);
  });
});

test("detects repository-owned install lifecycle scripts", async () => {
  await withRepo(async ({ repoDir }) => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({
      name: "root",
      scripts: { test: "node --test" },
    }));
    await mkdir(join(repoDir, "packages", "app"), { recursive: true });
    await writeFile(join(repoDir, "packages", "app", "package.json"), JSON.stringify({
      name: "app",
      scripts: { postinstall: "node scripts/generate.js" },
    }));

    assert.equal(repositoryHasInstallLifecycleScripts(repoDir), true);

    await writeFile(join(repoDir, "packages", "app", "package.json"), JSON.stringify({
      name: "app",
      scripts: { build: "tsc" },
    }));
    assert.equal(repositoryHasInstallLifecycleScripts(repoDir), false);
  });
});
