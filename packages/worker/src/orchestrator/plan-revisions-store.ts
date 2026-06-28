import type { AnnotationThread } from "@codevil/shared";
import {
  AnnotationLookupRowSchema,
  AnnotationReplyDbRowSchema,
  annotationReplyFromDbRow,
  OpenAnnotationDbRowSchema,
  parseAnnotationAnchorJson,
  parseSqliteRow,
  PlanRevisionFullRowSchema,
  PlanRevisionLockedRowSchema,
} from "@codevil/shared";

export function loadPlanRevision(
  sql: SqlStorage,
  runId: string,
  round: number,
): { locked_at: string | null } | null {
  for (const row of sql.exec(
    "SELECT locked_at FROM plan_revisions WHERE run_id = ? AND round = ?",
    runId,
    round,
  )) {
    return parseSqliteRow(
      PlanRevisionLockedRowSchema,
      row as Record<string, unknown>,
      "sqlite_plan_revision",
    );
  }
  return null;
}

export function loadFullPlanRevision(
  sql: SqlStorage,
  runId: string,
  round: number,
): { markdown: string; locked_at: string | null } | null {
  for (const row of sql.exec(
    "SELECT markdown, locked_at FROM plan_revisions WHERE run_id = ? AND round = ?",
    runId,
    round,
  )) {
    return parseSqliteRow(
      PlanRevisionFullRowSchema,
      row as Record<string, unknown>,
      "sqlite_plan_revision",
    );
  }
  return null;
}

export function loadAnnotationReplies(
  sql: SqlStorage,
  annotationId: string,
): NonNullable<AnnotationThread["replies"]> {
  const replies: NonNullable<AnnotationThread["replies"]> = [];
  for (const row of sql.exec(
    `SELECT id, author_id, author_name, body, created_at
     FROM annotation_replies
     WHERE annotation_id = ?
     ORDER BY created_at ASC`,
    annotationId,
  )) {
    const parsed = parseSqliteRow(
      AnnotationReplyDbRowSchema,
      row as Record<string, unknown>,
      "sqlite_annotation_reply",
    );
    if (parsed) replies.push(annotationReplyFromDbRow(parsed));
  }
  return replies;
}

export function loadOpenAnnotationThreads(
  sql: SqlStorage,
  runId: string,
  round: number,
): AnnotationThread[] {
  const threads: AnnotationThread[] = [];
  for (const row of sql.exec(
    `SELECT id, anchor_json, author_id, author_name, comment, status, created_at
     FROM annotations
     WHERE revision_run_id = ? AND revision_round = ? AND status = 'open'
     ORDER BY created_at ASC`,
    runId,
    round,
  )) {
    const parsed = parseSqliteRow(
      OpenAnnotationDbRowSchema,
      row as Record<string, unknown>,
      "sqlite_annotation",
    );
    if (!parsed) continue;

    const anchor = parseAnnotationAnchorJson(parsed.anchor_json);
    if (!anchor) continue;

    threads.push({
      id: parsed.id,
      run_id: runId,
      round,
      anchor,
      author: {
        id: parsed.author_id,
        name: parsed.author_name,
      },
      comment: parsed.comment,
      status: parsed.status,
      created_at: parsed.created_at,
      replies: loadAnnotationReplies(sql, parsed.id),
    });
  }
  return threads;
}

export function loadAnnotation(
  sql: SqlStorage,
  id: string,
): {
  revision_run_id: string;
  revision_round: number;
  author_id: string;
  status: string;
} | null {
  for (const row of sql.exec(
    `SELECT revision_run_id, revision_round, author_id, status
     FROM annotations
     WHERE id = ?`,
    id,
  )) {
    return parseSqliteRow(
      AnnotationLookupRowSchema,
      row as Record<string, unknown>,
      "sqlite_annotation_lookup",
    );
  }
  return null;
}
