import { z } from "zod";
import { ParticipantIdentitySchema } from "./room.js";

export const DomMetaSchema = z.object({
  parentTagName: z.string().min(1),
  parentIndex: z.number().int().nonnegative(),
  textOffset: z.number().int().nonnegative(),
});

export const AnnotationAnchorSchema = z.object({
  startMeta: DomMetaSchema,
  endMeta: DomMetaSchema,
  text: z.string().min(1),
  blockId: z.string().min(1),
  sourceLine: z.number().int().positive(),
});

export const AnnotationStatusSchema = z.enum(["open", "withdrawn", "consumed"]);

export const AnnotationReplySchema = z.object({
  id: z.string(),
  author: ParticipantIdentitySchema,
  comment: z.string().trim().min(1).max(20_000),
  created_at: z.string(),
});

export const AnnotationThreadSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  round: z.number().int().nonnegative(),
  anchor: AnnotationAnchorSchema,
  author: ParticipantIdentitySchema,
  comment: z.string().trim().min(1).max(20_000),
  status: AnnotationStatusSchema,
  created_at: z.string(),
  replies: z.array(AnnotationReplySchema).optional(),
});

export const ConflictOptionSchema = z.object({
  thread_id: z.string(),
  gist: z.string().trim().min(1).max(2_000),
});

export const ConflictStatusSchema = z.enum(["open", "resolved", "discarded"]);

export const AnnotationConflictSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  round: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(4_000),
  options: z.array(ConflictOptionSchema).min(2),
  status: ConflictStatusSchema,
});

export const BriefItemSchema = z.object({
  instruction: z.string().trim().min(1).max(20_000),
  source_thread_ids: z.array(z.string()),
});

export type DomMeta = z.infer<typeof DomMetaSchema>;
export type AnnotationAnchor = z.infer<typeof AnnotationAnchorSchema>;
export type AnnotationStatus = z.infer<typeof AnnotationStatusSchema>;
export type AnnotationReply = z.infer<typeof AnnotationReplySchema>;
export type AnnotationThread = z.infer<typeof AnnotationThreadSchema>;
export type ConflictOption = z.infer<typeof ConflictOptionSchema>;
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;
export type AnnotationConflict = z.infer<typeof AnnotationConflictSchema>;
export type BriefItem = z.infer<typeof BriefItemSchema>;
