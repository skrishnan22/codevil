import { z } from "zod";

export const PreviewFrameworkSchema = z.enum([
  "next",
  "vite",
  "react-scripts",
  "django",
  "rails",
  "make",
  "just",
  "npm",
]);

export const PreviewAppSchema = z.object({
  key: z.string(),
  name: z.string(),
  cwd: z.string(),
  framework: PreviewFrameworkSchema,
  command: z.string(),
  port: z.number(),
});

export type PreviewFramework = z.infer<typeof PreviewFrameworkSchema>;
export type PreviewApp = z.infer<typeof PreviewAppSchema>;
