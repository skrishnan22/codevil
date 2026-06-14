import { z } from "zod";

export const QuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(2_000),
  detail: z.string().max(8_000).optional(),
});

export const AnswerableBySchema = z.enum(["decider", "anyone"]);

export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type AnswerableBy = z.infer<typeof AnswerableBySchema>;
