import { z } from "zod";

import {
  AnnotationAnchorSchema,
  type AnnotationAnchor,
  type AnnotationReply,
} from "./annotations.js";
import { AnswerableBySchema } from "./questions.js";

const nullableString = z.union([z.string(), z.null()]);

export const QuestionRowSchema = z.object({
  run_id: z.string(),
  status: z.string(),
  answerable_by: AnswerableBySchema,
  assigned_to_id: nullableString,
  assigned_to_name: nullableString,
});

export type QuestionRow = z.infer<typeof QuestionRowSchema>;

export const PlanRevisionLockedRowSchema = z.object({
  locked_at: nullableString,
});

export const PlanRevisionFullRowSchema = z.object({
  markdown: z.string(),
  locked_at: nullableString,
});

export const AnnotationReplyDbRowSchema = z.object({
  id: z.string(),
  author_id: z.string(),
  author_name: z.string(),
  body: z.string(),
  created_at: z.string(),
});

export const OpenAnnotationDbRowSchema = z.object({
  id: z.string(),
  anchor_json: z.string(),
  author_id: z.string(),
  author_name: z.string(),
  comment: z.string(),
  status: z.literal("open"),
  created_at: z.string(),
});

export const AnnotationLookupRowSchema = z.object({
  revision_run_id: z.string(),
  revision_round: z.number(),
  author_id: z.string(),
  status: z.string(),
});

export const RequestIdRowSchema = z.object({
  request_id: z.string(),
});

export function parseSqliteRow<S extends z.ZodTypeAny>(
  schema: S,
  row: Record<string, unknown>,
  boundary: string,
): z.infer<S> | null {
  const result = schema.safeParse(row);
  if (result.success) return result.data;
  console.error(JSON.stringify({
    kind: "validation_drop",
    boundary,
    issues: result.error.issues,
  }));
  return null;
}

export function parseAnnotationAnchorJson(raw: string): AnnotationAnchor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(JSON.stringify({
      kind: "validation_drop",
      boundary: "sqlite_annotation_anchor",
      raw_type: null,
      issues: [{ message: "Invalid JSON in anchor_json column" }],
    }));
    return null;
  }

  const result = AnnotationAnchorSchema.safeParse(parsed);
  if (!result.success) {
    console.error(JSON.stringify({
      kind: "validation_drop",
      boundary: "sqlite_annotation_anchor",
      issues: result.error.issues,
    }));
    return null;
  }
  return result.data;
}

export function annotationReplyFromDbRow(
  row: z.infer<typeof AnnotationReplyDbRowSchema>,
): AnnotationReply {
  return {
    id: row.id,
    author: { id: row.author_id, name: row.author_name },
    comment: row.body,
    created_at: row.created_at,
  };
}
