import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceSnapshotInsert,
  latestWorkspaceSnapshotSelect,
  normalizeRepoCacheKey,
} from "../dist/workspace-cache.js";

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
