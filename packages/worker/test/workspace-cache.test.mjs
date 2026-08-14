import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_CACHE_VERSION,
  buildWorkspaceSnapshotInsert,
  createWorkspaceCacheSnapshot,
  latestWorkspaceSnapshotSelect,
  normalizeRepoCacheKey,
} from "../dist/workspace-cache.js";

test("workspace cache version changes for the supported runtime and ownership boundary", () => {
  assert.equal(WORKSPACE_CACHE_VERSION, "workspace-cache-v3");
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
