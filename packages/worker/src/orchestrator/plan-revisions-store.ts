import type { AnnotationAnchor, AnnotationThread } from "@codevil/shared";

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
    return { locked_at: row["locked_at"] as string | null };
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
    return {
      markdown: row["markdown"] as string,
      locked_at: row["locked_at"] as string | null,
    };
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
    replies.push({
      id: row["id"] as string,
      author: {
        id: row["author_id"] as string,
        name: row["author_name"] as string,
      },
      comment: row["body"] as string,
      created_at: row["created_at"] as string,
    });
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
    const id = row["id"] as string;
    threads.push({
      id,
      run_id: runId,
      round,
      anchor: JSON.parse(row["anchor_json"] as string) as AnnotationAnchor,
      author: {
        id: row["author_id"] as string,
        name: row["author_name"] as string,
      },
      comment: row["comment"] as string,
      status: row["status"] as "open",
      created_at: row["created_at"] as string,
      replies: loadAnnotationReplies(sql, id),
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
    return {
      revision_run_id: row["revision_run_id"] as string,
      revision_round: row["revision_round"] as number,
      author_id: row["author_id"] as string,
      status: row["status"] as string,
    };
  }
  return null;
}
