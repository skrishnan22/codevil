import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_CACHE_VERSION,
  buildWorkspaceSnapshotInsert,
  createWorkspaceCacheSnapshot,
  isRetryableWorkspaceCacheError,
  isRetryableRestoreError,
  latestWorkspaceSnapshotSelect,
  normalizeRepoCacheKey,
  restoreLatestWorkspaceCache,
} from "../dist/workspace-cache.js";

test("workspace cache version changes for the supported runtime and ownership boundary", () => {
  assert.equal(WORKSPACE_CACHE_VERSION, "workspace-cache-v4");
});

test("normalizeRepoCacheKey removes credentials and unstable URL suffixes", () => {
  assert.equal(
    normalizeRepoCacheKey("https://x-access-token:secret@github.com/Example/App.git/"),
    "github.com/example/app",
  );
});

test("latestWorkspaceSnapshotSelect reads the newest ready snapshot for a repo and cache version", () => {
  assert.deepEqual(
    latestWorkspaceSnapshotSelect({
      repo: "https://github.com/example/app.git",
      cacheVersion: "workspace-cache-v1",
    }),
    {
      sql: `SELECT * FROM workspace_snapshots
      WHERE repo_key = ? AND cache_version = ? AND status = 'ready'
      ORDER BY created_at DESC
      LIMIT 1`,
      bindings: ["github.com/example/app", "workspace-cache-v1"],
    },
  );
});

test("buildWorkspaceSnapshotInsert stores a serializable Cloudflare backup handle", () => {
  assert.deepEqual(
    buildWorkspaceSnapshotInsert({
      id: "wsc_123",
      repo: "https://github.com/example/app.git",
      cacheVersion: "workspace-cache-v1",
      sourceSessionId: "ses_123",
      backup: { id: "backup_123", dir: "/workspace", localBucket: true },
      createdAt: "2026-06-23T00:00:00.000Z",
    }),
    {
      sql: `INSERT INTO workspace_snapshots (
      id, repo_key, repo, cache_version, source_session_id,
      backup_id, backup_dir, backup_local_bucket, status,
      created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      bindings: [
        "wsc_123",
        "github.com/example/app",
        "https://github.com/example/app.git",
        "workspace-cache-v1",
        "ses_123",
        "backup_123",
        "/workspace",
        1,
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.000Z",
      ],
    },
  );
});

test("createWorkspaceCacheSnapshot reports backup failures by phase", async () => {
  const result = await createWorkspaceCacheSnapshot({
    db: {},
    sandbox: {
      createBackup: async () => {
        throw new Error("backup expired");
      },
    },
    repo: "https://github.com/example/app.git",
    sourceSessionId: "ses_123",
  });

  assert.deepEqual(result, {
    created: false,
    phase: "backup",
    reason: "backup expired",
  });
});

test("workspace cache recognizes a Durable Object reset as retryable", () => {
  assert.equal(
    isRetryableWorkspaceCacheError(new Error("Durable Object reset because its code was updated")),
    true,
  );
});

test("createWorkspaceCacheSnapshot reports D1 persistence failures by phase", async () => {
  const result = await createWorkspaceCacheSnapshot({
    db: {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("D1 unavailable");
          },
        }),
      }),
    },
    sandbox: {
      createBackup: async () => ({ id: "backup_123", dir: "/workspace" }),
    },
    repo: "https://github.com/example/app.git",
    sourceSessionId: "ses_123",
  });

  assert.deepEqual(result, {
    created: false,
    phase: "persist",
    reason: "D1 unavailable",
  });
});

function createRestoreDb(row) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
        run: async () => {},
      }),
    }),
  };
}

const SNAPSHOT_ROW = {
  id: "wsc_123",
  repo_key: "github.com/example/app",
  repo: "https://github.com/example/app.git",
  cache_version: WORKSPACE_CACHE_VERSION,
  source_session_id: "ses_old",
  backup_id: "backup_123",
  backup_dir: "/workspace",
  backup_local_bucket: 0,
  status: "ready",
  created_at: "2026-06-23T00:00:00.000Z",
  last_used_at: "2026-06-23T00:00:00.000Z",
};

test("restore retries transient container flakes before giving up", async () => {
  let attempts = 0;
  const result = await restoreLatestWorkspaceCache({
    db: createRestoreDb(SNAPSHOT_ROW),
    sandbox: {
      restoreBackup: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Session '__sandbox_backup_x' shell exited (exit code: 1)");
        }
        return { id: "backup_123" };
      },
    },
    repo: "https://github.com/example/app.git",
    sleep: (ms) => Promise.resolve(ms),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result, { restored: true, snapshotId: "wsc_123" });
});

test("restore does not retry permanent backup errors", async () => {
  let attempts = 0;
  const expired = Object.assign(new Error("backup_expired: TTL elapsed"), { name: "BackupExpiredError" });
  const result = await restoreLatestWorkspaceCache({
    db: createRestoreDb(SNAPSHOT_ROW),
    sandbox: {
      restoreBackup: async () => {
        attempts += 1;
        throw expired;
      },
    },
    repo: "https://github.com/example/app.git",
    sleep: (ms) => Promise.resolve(ms),
  });

  assert.equal(attempts, 1);
  assert.equal(result.restored, false);
  assert.equal(result.phase, "restore");
});

test("isRetryableRestoreError classifies permanent vs transient failures", () => {
  const expired = Object.assign(new Error("TTL elapsed"), { name: "BackupExpiredError" });
  const notFound = Object.assign(new Error("missing"), { name: "BackupNotFoundError" });
  assert.equal(isRetryableRestoreError(expired), false);
  assert.equal(isRetryableRestoreError(notFound), false);
  assert.equal(isRetryableRestoreError(new Error("Session '__sandbox_backup_1' shell exited (exit code: 1)")), true);
  assert.equal(isRetryableRestoreError(new Error("SandboxError: HTTP error! status: 500")), true);
});

test("workspace cache treats container blips and HTTP 5xx as retryable", () => {
  assert.equal(isRetryableWorkspaceCacheError(new Error("SandboxError: HTTP error! status: 500")), true);
  assert.equal(
    isRetryableWorkspaceCacheError(new Error("Container failed to become ready: Failed after 8 attempts over 135s")),
    true,
  );
  assert.equal(isRetryableWorkspaceCacheError(new Error("Network connection lost.")), true);
  assert.equal(isRetryableWorkspaceCacheError(new Error("Session shell exited (exit code: 1)")), true);
});

test("workspace cache does not treat client errors as retryable", () => {
  assert.equal(isRetryableWorkspaceCacheError(new Error("SandboxError: HTTP error! status: 400")), false);
  assert.equal(isRetryableWorkspaceCacheError(new Error("backup expired")), false);
});
