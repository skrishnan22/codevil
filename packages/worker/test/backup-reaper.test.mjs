import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_OBJECT_PREFIX,
  backupExpiryCutoffMs,
  expiredWorkspaceSnapshotsDelete,
  selectExpiredBackupKeys,
  sweepWorkspaceBackups,
} from "../dist/backup-reaper.js";

const TTL_30D = 30 * 24 * 60 * 60;

test("backup expiry cutoff subtracts the TTL from now", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  assert.equal(backupExpiryCutoffMs(now), now.getTime() - TTL_30D * 1000);
  assert.equal(backupExpiryCutoffMs(now, 60), now.getTime() - 60_000);
});

test("selectExpiredBackupKeys returns keys older than the TTL only", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const older = { key: "backups/x/data.sqsh", uploaded: new Date("2026-07-01T00:00:00.000Z") };
  const recent = { key: "backups/y/data.sqsh", uploaded: new Date("2026-09-18T00:00:00.000Z") };
  const boundary = { key: "backups/z/data.sqsh", uploaded: new Date(backupExpiryCutoffMs(now) - 1) };
  const notAged = { key: "backups/w/meta.json", uploaded: new Date(backupExpiryCutoffMs(now) + 1) };

  assert.deepEqual(
    selectExpiredBackupKeys([older, recent, boundary, notAged], now),
    ["backups/x/data.sqsh", "backups/z/data.sqsh"],
  );
});

test("selectExpiredBackupKeys never deletes objects without an upload timestamp", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const untracked = { key: "backups/x/data.sqsh", uploaded: null };
  assert.deepEqual(selectExpiredBackupKeys([untracked], now), []);
});

test("expiredWorkspaceSnapshotsDelete scopes deletion to rows older than the TTL", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  assert.deepEqual(expiredWorkspaceSnapshotsDelete(now, 60), {
    sql: "DELETE FROM workspace_snapshots WHERE created_at < ?",
    bindings: [new Date(now.getTime() - 60_000).toISOString()],
  });
});

test("sweepWorkspaceBackups lists, filters, and deletes expired objects by page", async () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const oldObject = { key: "backups/a/data.sqsh", uploaded: new Date("2026-08-01T00:00:00.000Z") };
  const oldMeta = { key: "backups/a/meta.json", uploaded: new Date("2026-08-01T00:00:00.000Z") };
  const freshObject = { key: "backups/b/data.sqsh", uploaded: new Date("2026-09-19T00:00:00.000Z") };

  const deletedPages = [];
  const bucket = {
    list: async () => ({ objects: [oldObject, freshObject, oldMeta], truncated: false }),
    delete: async (keys) => deletedPages.push(keys),
  };
  const runs = [];
  const db = {
    prepare: () => ({
      bind: (...args) => {
        runs.push(args);
        return { run: async () => ({ meta: { changes: 2 } }) };
      },
    }),
  };

  const result = await sweepWorkspaceBackups(bucket, db, now);

  assert.deepEqual(result, { listed: 3, deleted: 2, expiredRows: 2 });
  assert.deepEqual(deletedPages, [["backups/a/data.sqsh", "backups/a/meta.json"]]);
  assert.deepEqual(runs[0], [new Date(backupExpiryCutoffMs(now)).toISOString()]);
  assert.equal(BACKUP_OBJECT_PREFIX, "backups/");
});

test("sweepWorkspaceBackups follows the pagination cursor", async () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const pages = [
    {
      objects: [
        { key: "backups/a/data.sqsh", uploaded: new Date("2026-08-01T00:00:00.000Z") },
      ],
      truncated: true,
      cursor: "page-2",
    },
    {
      objects: [
        { key: "backups/b/meta.json", uploaded: new Date("2026-08-02T00:00:00.000Z") },
      ],
      truncated: false,
    },
  ];
  const listCalls = [];
  const deletedPages = [];
  const bucket = {
    list: async (options) => {
      listCalls.push(options);
      return pages.length ? pages.shift() : { objects: [], truncated: false };
    },
    delete: async (keys) => deletedPages.push(keys),
  };
  const db = {
    prepare: () => ({
      bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
    }),
  };

  const result = await sweepWorkspaceBackups(bucket, db, now);

  assert.equal(result.listed, 2);
  assert.equal(result.deleted, 2);
  assert.deepEqual(listCalls.map((o) => o.cursor), [undefined, "page-2"]);
  assert.deepEqual(deletedPages, [["backups/a/data.sqsh"], ["backups/b/meta.json"]]);
});

test("sweepWorkspaceBackups tolerates a missing R2 binding (local dev)", async () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const db = {
    prepare: () => ({
      bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
    }),
  };

  const result = await sweepWorkspaceBackups(undefined, db, now);

  assert.deepEqual(result, { listed: 0, deleted: 0, expiredRows: 0 });
});