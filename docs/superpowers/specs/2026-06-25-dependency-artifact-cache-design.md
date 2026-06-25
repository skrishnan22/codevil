# Dependency Artifact Cache Design

**Date:** 2026-06-25
**Status:** Approved

---

## Overview

Codevil currently snapshots the repository and package-manager download stores, but excludes installed dependencies such as `node_modules`. A restored sandbox therefore avoids most registry downloads while still paying the cost of extracting packages, linking dependency trees, and running lifecycle or native build scripts.

This change adds validated installed-dependency reuse. A warm sandbox restores dependency artifacts, refreshes tracked repository files, computes a dependency fingerprint for the refreshed checkout, and skips installation only when that fingerprint exactly matches the snapshot marker.

The first implementation supports the JavaScript package managers already recognized by sandbox setup: npm, pnpm, Yarn, and Bun. The strategy boundary remains ecosystem-neutral so Python, Ruby, Rust, Go, and JVM implementations can be added later without changing workspace snapshot storage.

## Goals

- Skip automatic package installation when restored dependency artifacts are compatible with the refreshed checkout and sandbox runtime.
- Reuse caches across source-only commits when dependency inputs have not changed.
- Fall back to the existing install command and warm download stores when compatibility cannot be proven.
- Support JavaScript monorepos and Yarn Plug'n'Play in addition to root `node_modules`.
- Keep custom `.codevil/setup.sh` behavior unchanged: explicit setup scripts always run.
- Expose enough status and tracing information to compare restore, repository refresh, fingerprinting, and setup time.

## Non-Goals

- Sharing one dependency snapshot across different repositories.
- Deduplicating dependency artifacts independently from workspace snapshots.
- Reusing build outputs such as `dist`, framework caches, or compiled application bundles.
- Automatically caching Python virtual environments, Cargo targets, Go build caches, Gradle caches, or other ecosystems in this iteration.
- Proving that arbitrary custom setup scripts are cacheable.

## Current Flow

The existing warm-start flow is:

1. Select the latest ready workspace snapshot for the repository.
2. Restore `/workspace` from R2.
3. Refresh the cached checkout with shallow `git fetch` and `git reset`.
4. Run `git clean -fdx`, which deletes ignored dependency artifacts.
5. Run the detected package-manager install command with restored download-store paths.
6. Snapshot `/workspace`, excluding all `node_modules` directories.

Snapshots and restores are working in production. The performance gap remains because steps 4 and 5 discard and reconstruct installed dependencies.

## Architecture

### Dependency Cache Strategy

The sandbox runtime will use a dependency strategy abstraction:

```typescript
interface DependencyCacheStrategy {
  ecosystem: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  installCommand: string;
  fingerprint(repoDir: string): Promise<DependencyFingerprint>;
  preservePatterns: string[];
  removeArtifacts(repoDir: string): Promise<void>;
  artifactsPresent(repoDir: string): boolean;
}
```

The strategy owns:

- Detection of the active package manager.
- The normal install command.
- Files that determine dependency compatibility.
- Installed artifacts that must survive repository cleanup.
- Artifact removal after a mismatch.
- The minimum evidence required to consider restored artifacts present.

The generic runtime owns marker persistence, comparison, status events, timing, and fallback behavior.

### Snapshot Marker

After a successful automatic package installation, the sandbox writes:

```text
/workspace/cache/dependency-artifacts.json
```

The marker is included in the workspace snapshot and contains:

```typescript
interface DependencyArtifactMarker {
  formatVersion: 1;
  ecosystem: string;
  packageManager: string;
  fingerprint: string;
  inputs: string[];
  createdAt: string;
}
```

`inputs` records normalized relative paths used for the hash. It is diagnostic metadata; equality is decided by `fingerprint`.

The marker must not contain credentials, absolute host paths, or repository contents.

## Dependency Fingerprint

The fingerprint is a SHA-256 hash of a deterministic manifest. Entries are sorted by normalized repository-relative path before hashing.

For JavaScript repositories, the manifest includes:

- The active lockfile:
  - npm: `package-lock.json` or `npm-shrinkwrap.json`
  - pnpm: `pnpm-lock.yaml`
  - Yarn: `yarn.lock`
  - Bun: `bun.lock` or `bun.lockb`
- Root and workspace `package.json` files, excluding files under dependency artifacts.
- Package-manager configuration that can affect resolution or installation when present:
  - `.npmrc`
  - `pnpm-workspace.yaml`
  - `.yarnrc.yml`
  - `.yarnrc`
  - `bunfig.toml`
- Actual package-manager name and version used by the sandbox.
- Node version.
- Node ABI (`process.versions.modules`).
- Operating system and architecture.
- Linux libc implementation.
- Dependency marker format version.

Including workspace `package.json` files catches dependency declarations, workspace layout changes, lifecycle-script changes, and local package changes that may not alter a lockfile. Including the actual tool and runtime versions prevents native modules or package-manager layouts from being reused across incompatible sandbox images.

Repositories without a recognized lockfile are not eligible for installed-artifact reuse. Their existing setup behavior remains unchanged.

Repositories with root or workspace install lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`, and related npm install hooks) are also ineligible for install skipping. Those scripts can depend on arbitrary repository files or generate outputs outside dependency directories, so a dependency-only fingerprint cannot prove their side effects remain valid. Their installs still use the restored package-manager download stores.

## Installed Artifacts

The JavaScript strategies preserve and validate these package-manager-owned artifacts:

- npm, pnpm, and Bun:
  - Root and nested `node_modules` directories.
- Yarn node-modules linker:
  - Root and nested `node_modules` directories.
  - `.yarn/install-state.gz` when present.
- Yarn Plug'n'Play:
  - `.pnp.cjs`
  - `.pnp.loader.mjs`
  - `.yarn/cache`
  - `.yarn/unplugged`
  - `.yarn/install-state.gz`
  - `.yarn/build-state.yml`

The strategy will preserve only known dependency artifacts during `git clean -fdx`. Other ignored files remain subject to cleanup.

When a fingerprint mismatches or artifact validation fails, the strategy deletes all known installed artifacts before installation. Package-manager download stores under `/workspace/cache` remain intact and continue to accelerate the fallback install.

## Warm-Start Data Flow

1. Restore the latest repository workspace snapshot.
2. Read the dependency artifact marker from `/workspace/cache`.
3. Refresh tracked repository files with shallow fetch and hard reset.
4. Clean untracked and ignored files while excluding only strategy-owned dependency artifacts.
5. Detect the strategy from the refreshed checkout.
6. Compute the refreshed dependency fingerprint.
7. Compare the refreshed fingerprint with the restored marker and validate that required artifacts exist.
8. On an exact match:
   - Keep installed artifacts.
   - Skip the automatic package-manager install command.
   - Emit a status event stating that cached dependencies were reused.
9. On mismatch, missing marker, changed package manager, or missing artifacts:
   - Delete all known installed artifacts for the detected and previously recorded JavaScript strategies.
   - Run the normal install command with existing warm download-store environment variables.
   - Compute and write a new marker after successful installation.
10. Mark the repository ready.
11. Create the next workspace snapshot, including installed dependency artifacts and the marker.

## Cold-Start Data Flow

1. Shallow-clone the repository.
2. Detect the package manager.
3. Run the normal install command with package-manager download stores under `/workspace/cache`.
4. Compute and write the dependency artifact marker after successful installation.
5. Create the workspace snapshot including the repository, installed dependencies, download stores, and marker.

## Custom Setup Scripts

If `.codevil/setup.sh` exists:

- It always runs on cold and warm starts.
- Codevil does not skip it based on a dependency fingerprint.
- Codevil does not write an installed-dependency marker on its behalf.
- Restored JavaScript dependency artifacts are not treated as valid evidence for skipping the script.

This preserves the current contract because the script may install system packages, generate files, run migrations, or perform work unrelated to dependency installation.

## Git Refresh Contract

Git does not create or update installed dependencies. The only destructive interaction is Codevil's cleanup command.

`GitDriver.refresh` will accept cleanup exclusion patterns supplied by the detected/restored dependency strategy. Its sequence remains:

1. Set the authenticated remote URL temporarily when required.
2. Shallow-fetch the latest default branch.
3. Reset tracked files to `origin/HEAD`.
4. Run `git clean -fdx` with explicit exclusions for known installed-dependency artifacts.
5. Restore the credential-free remote URL.

If no dependency strategy or marker is available, refresh performs the existing full cleanup without exclusions.

## Snapshot Storage

The existing R2 workspace backup remains the storage unit. No new D1 table or R2 object type is required.

The workspace backup will stop excluding `node_modules`. Snapshot selection remains:

```text
repository key + workspace cache version, newest ready snapshot
```

Dependency compatibility is evaluated inside the restored sandbox after Git refresh. This preserves reuse of repository and download-store caches even when installed dependencies are incompatible.

Because snapshots become larger, timing and size should be monitored before introducing separate dependency snapshots or cross-repository deduplication.

## Failure Handling

- Missing or malformed marker: treat as a dependency-cache miss.
- Fingerprint computation failure: remove installed artifacts and run install.
- Package-manager version lookup failure: treat as a dependency-cache miss.
- Missing expected artifacts: treat as a dependency-cache miss.
- Artifact removal failure: fail setup rather than run installation over a partially reused tree.
- Install failure: preserve the current setup failure behavior and do not update the marker.
- Snapshot creation failure: log and continue serving the ready sandbox, as today.
- Snapshot restore failure: fall back to shallow clone and normal installation, as today.

No cache failure may silently skip installation unless compatibility and artifact presence are both proven.

## Observability

The sandbox will emit or preserve spans for:

- `sandbox.repo_refresh`
- `sandbox.dependency_fingerprint`
- `sandbox.setup`

Setup status will distinguish:

- Cached dependencies reused; install skipped.
- Dependency cache unavailable or incompatible; install running.
- Explicit setup script running.

Fingerprint values may be logged, but file contents and credentials must not be logged.

## Testing

Unit and integration tests will cover:

- Deterministic fingerprinting regardless of file discovery order.
- Fingerprint changes for lockfile, workspace `package.json`, package-manager version, Node ABI, platform, architecture, and marker format changes.
- Fingerprint stability across source-only changes.
- npm, pnpm, Yarn, Bun, monorepo, and Yarn PnP detection.
- Git cleanup exclusions preserve dependency artifacts while removing unrelated ignored files.
- Exact match skips installation.
- Mismatch removes artifacts and runs installation.
- Missing artifacts force installation even when the fingerprint matches.
- Successful installation writes a marker.
- Failed installation does not write a marker.
- Explicit `.codevil/setup.sh` always runs.
- Cold clone still installs and snapshots dependencies.
- Existing snapshot restore misses still fall back to clone.

## Rollout

The dependency marker format starts at version `1`. The workspace cache version will be incremented when this behavior ships so snapshots created by the old node-modules-excluding implementation are not mistaken for installed-artifact snapshots.

The first post-deploy session for each repository will be a cold dependency-cache fill. Subsequent sessions can skip installation when the dependency fingerprint matches.
