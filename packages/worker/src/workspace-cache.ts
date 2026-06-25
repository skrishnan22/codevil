import type { DirectoryBackup, Sandbox } from "@cloudflare/sandbox";

import {
  getCodevilSandbox,
  retrySandboxOperation,
} from "./sandbox.js";

export const WORKSPACE_CACHE_VERSION = "workspace-cache-v2";
export const WORKSPACE_CACHE_DIR = "/workspace";
export const WORKSPACE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SqlStatement {
  sql: string;
  bindings: unknown[];
}

export interface WorkspaceSnapshotRow {
  id: string;
  repo_key: string;
  repo: string;
  cache_version: string;
  source_session_id: string;
  backup_id: string;
  backup_dir: string;
  backup_local_bucket: number;
  status: "ready" | "failed";
  created_at: string;
  last_used_at: string;
}

export interface WorkspaceSnapshotInsert {
  id: string;
  repo: string;
  cacheVersion: string;
  sourceSessionId: string;
  backup: DirectoryBackup;
  createdAt: string;
}

export interface WorkspaceCacheRestoreResult {
  restored: boolean;
  snapshotId?: string;
  reason?: string;
}

export interface WorkspaceCacheCreateResult {
  created: boolean;
  snapshotId?: string;
  reason?: string;
}

export interface WorkspaceCacheSandbox {
  restoreBackup(backup: DirectoryBackup): Promise<unknown>;
  createBackup(options: {
    dir: string;
    name?: string;
    ttl?: number;
    excludes?: string[];
    compression?: { format?: "gzip" | "lz4" | "zstd"; threads?: number };
    multipart?: boolean;
    localBucket?: boolean;
  }): Promise<DirectoryBackup>;
}

export function normalizeRepoCacheKey(repo: string): string {
  const trimmed = repo.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `${url.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function latestWorkspaceSnapshotSelect(input: {
  repo: string;
  cacheVersion: string;
}): SqlStatement {
  return {
    sql: `SELECT * FROM workspace_snapshots
      WHERE repo_key = ? AND cache_version = ? AND status = 'ready'
      ORDER BY created_at DESC
      LIMIT 1`,
    bindings: [normalizeRepoCacheKey(input.repo), input.cacheVersion],
  };
}

export function workspaceSnapshotUsedUpdate(id: string, usedAt: string): SqlStatement {
  return {
    sql: "UPDATE workspace_snapshots SET last_used_at = ? WHERE id = ?",
    bindings: [usedAt, id],
  };
}

export function buildWorkspaceSnapshotInsert(input: WorkspaceSnapshotInsert): SqlStatement {
  return {
    sql: `INSERT INTO workspace_snapshots (
      id, repo_key, repo, cache_version, source_session_id,
      backup_id, backup_dir, backup_local_bucket, status,
      created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    bindings: [
      input.id,
      normalizeRepoCacheKey(input.repo),
      input.repo,
      input.cacheVersion,
      input.sourceSessionId,
      input.backup.id,
      input.backup.dir,
      input.backup.localBucket ? 1 : 0,
      input.createdAt,
      input.createdAt,
    ],
  };
}

export function backupFromWorkspaceSnapshot(row: WorkspaceSnapshotRow): DirectoryBackup {
  return {
    id: row.backup_id,
    dir: row.backup_dir,
    ...(row.backup_local_bucket ? { localBucket: true } : {}),
  };
}

export async function restoreLatestWorkspaceCache(input: {
  db: D1Database;
  sandbox: WorkspaceCacheSandbox;
  repo: string;
  cacheVersion?: string;
  now?: string;
}): Promise<WorkspaceCacheRestoreResult> {
  const select = latestWorkspaceSnapshotSelect({
    repo: input.repo,
    cacheVersion: input.cacheVersion ?? WORKSPACE_CACHE_VERSION,
  });

  let row: WorkspaceSnapshotRow | null;
  try {
    row = await input.db.prepare(select.sql).bind(...select.bindings).first<WorkspaceSnapshotRow>();
  } catch (error) {
    return { restored: false, reason: errorMessage(error) };
  }
  if (!row) return { restored: false, reason: "cache miss" };

  try {
    await retrySandboxOperation(() => input.sandbox.restoreBackup(backupFromWorkspaceSnapshot(row)));
    const update = workspaceSnapshotUsedUpdate(row.id, input.now ?? new Date().toISOString());
    await input.db.prepare(update.sql).bind(...update.bindings).run();
    return { restored: true, snapshotId: row.id };
  } catch (error) {
    return { restored: false, snapshotId: row.id, reason: errorMessage(error) };
  }
}

export async function createWorkspaceCacheSnapshot(input: {
  db: D1Database;
  sandbox: WorkspaceCacheSandbox;
  repo: string;
  sourceSessionId: string;
  cacheVersion?: string;
  now?: string;
  ttlSeconds?: number;
}): Promise<WorkspaceCacheCreateResult> {
  try {
    const backup = await retrySandboxOperation(() =>
      input.sandbox.createBackup({
        dir: WORKSPACE_CACHE_DIR,
        name: `codevil-${normalizeRepoCacheKey(input.repo).replace(/[^a-z0-9_.-]+/g, "-")}`,
        ttl: input.ttlSeconds ?? WORKSPACE_CACHE_TTL_SECONDS,
        excludes: workspaceBackupExcludes(),
        compression: { format: "zstd" },
        multipart: true,
      }),
    );
    const id = `wsc_${crypto.randomUUID().replace(/-/g, "")}`;
    const insert = buildWorkspaceSnapshotInsert({
      id,
      repo: input.repo,
      cacheVersion: input.cacheVersion ?? WORKSPACE_CACHE_VERSION,
      sourceSessionId: input.sourceSessionId,
      backup,
      createdAt: input.now ?? new Date().toISOString(),
    });
    await input.db.prepare(insert.sql).bind(...insert.bindings).run();
    return { created: true, snapshotId: id };
  } catch (error) {
    return { created: false, reason: errorMessage(error) };
  }
}

export async function restoreLatestWorkspaceCacheForSandbox(input: {
  db: D1Database;
  binding: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  repo: string;
}): Promise<WorkspaceCacheRestoreResult> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getCodevilSandbox(getSandbox, input.binding, input.sessionId) as WorkspaceCacheSandbox;
  return restoreLatestWorkspaceCache({
    db: input.db,
    sandbox,
    repo: input.repo,
  });
}

export async function createWorkspaceCacheSnapshotForSandbox(input: {
  db: D1Database;
  binding: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  repo: string;
}): Promise<WorkspaceCacheCreateResult> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getCodevilSandbox(getSandbox, input.binding, input.sessionId) as WorkspaceCacheSandbox;
  return createWorkspaceCacheSnapshot({
    db: input.db,
    sandbox,
    repo: input.repo,
    sourceSessionId: input.sessionId,
  });
}

export function workspaceBackupExcludes(): string[] {
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
