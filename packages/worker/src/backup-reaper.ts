import { WORKSPACE_CACHE_TTL_SECONDS } from "./workspace-cache.js";

/**
 * Expired backup sweep for the `codevil-sandbox-backups` R2 bucket.
 *
 * Cloudflare Sandboxes stores each directory backup as two objects under
 * `backups/{backupId}/`: `data.sqsh` and `meta.json`. The `ttl` passed to
 * `createBackup` only causes restore-time rejection — the platform never
 * deletes the R2 objects — so a bucket can grow without bound unless
 * something reaps expired archives. This module deletes objects older than
 * the workspace-cache TTL (30 days) and removes the matching
 * `workspace_snapshots` rows so restores never target a missing archive.
 */

/** R2 object prefix under which sandbox backup archives are stored. */
export const BACKUP_OBJECT_PREFIX = "backups/";

/** Largest batch handed to a single R2 delete call / list page. */
export const BACKUP_REAPER_PAGE_LIMIT = 1000;

export interface BackupReaperResult {
  /** Objects inspected under the `backups/` prefix. */
  listed: number;
  /** R2 objects deleted (data.sqsh + meta.json per expired backup). */
  deleted: number;
  /** `workspace_snapshots` rows removed from D1. */
  expiredRows: number;
}

/** Epoch-ms threshold before which a backup object is considered expired. */
export function backupExpiryCutoffMs(
  now: Date,
  ttlSeconds = WORKSPACE_CACHE_TTL_SECONDS,
): number {
  return now.getTime() - ttlSeconds * 1000;
}

/**
 * Select the keys of backup objects whose upload time has passed the TTL.
 * Untimestamped objects are kept (never delete what we cannot date-check).
 */
export function selectExpiredBackupKeys(
  objects: readonly { key: string; uploaded: Date }[],
  now = new Date(),
  ttlSeconds = WORKSPACE_CACHE_TTL_SECONDS,
): string[] {
  const cutoff = backupExpiryCutoffMs(now, ttlSeconds);
  return objects
    .filter((object) => object.uploaded instanceof Date && object.uploaded.getTime() < cutoff)
    .map((object) => object.key);
}

/** D1 statement that removes workspace snapshot rows older than the TTL. */
export function expiredWorkspaceSnapshotsDelete(
  now = new Date(),
  ttlSeconds = WORKSPACE_CACHE_TTL_SECONDS,
): { sql: string; bindings: [string] } {
  return {
    sql: "DELETE FROM workspace_snapshots WHERE created_at < ?",
    bindings: [new Date(backupExpiryCutoffMs(now, ttlSeconds)).toISOString()],
  };
}

/**
 * Delete expired backup objects and their D1 snapshot rows.
 *
 * `bucket` is optional because the R2 binding is not configured in every
 * local/dev environment; without it the sweep is a no-op for storage. The
 * D1 row cleanup still runs so metadata cannot outlive intent.
 */
export async function sweepWorkspaceBackups(
  bucket: R2Bucket | undefined,
  db: D1Database,
  now = new Date(),
  opts: { ttlSeconds?: number; pageLimit?: number } = {},
): Promise<BackupReaperResult> {
  const ttlSeconds = opts.ttlSeconds ?? WORKSPACE_CACHE_TTL_SECONDS;
  const pageLimit = opts.pageLimit ?? BACKUP_REAPER_PAGE_LIMIT;

  let listed = 0;
  let deleted = 0;
  if (bucket) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix: BACKUP_OBJECT_PREFIX,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
      });
      const objects = page.objects ?? [];
      listed += objects.length;
      const expiredKeys = selectExpiredBackupKeys(objects, now, ttlSeconds);
      for (let offset = 0; offset < expiredKeys.length; offset += BACKUP_REAPER_PAGE_LIMIT) {
        const chunk = expiredKeys.slice(offset, offset + BACKUP_REAPER_PAGE_LIMIT);
        await bucket.delete(chunk);
        deleted += chunk.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  let expiredRows = 0;
  const statement = expiredWorkspaceSnapshotsDelete(now, ttlSeconds);
  const result = await db.prepare(statement.sql).bind(...statement.bindings).run();
  expiredRows = result.meta.changes ?? 0;

  return { listed, deleted, expiredRows };
}