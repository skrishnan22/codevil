import { z } from "zod";

export const EntrypointEnvSchema = z.object({
  CODEVIL_DO_WS_URL: z.string().min(1).optional(),
  CODEVIL_API_KEY: z.string().optional(),
  CODEVIL_WORKSPACE: z.string().optional(),
  CODEVIL_PROVIDER: z.string().optional(),
  CODEVIL_LLM_KEY_FILE: z.string().optional(),
});

export type EntrypointEnv = z.infer<typeof EntrypointEnvSchema>;

const ENTRYPOINT_ENV_KEYS = [
  "CODEVIL_DO_WS_URL",
  "CODEVIL_API_KEY",
  "CODEVIL_WORKSPACE",
  "CODEVIL_PROVIDER",
  "CODEVIL_LLM_KEY_FILE",
] as const satisfies readonly (keyof EntrypointEnv)[];

export function pickEntrypointEnvFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ENTRYPOINT_ENV_KEYS) {
    if (key in input) picked[key] = input[key];
  }
  return picked;
}

export function parseEntrypointEnv(
  input: Record<string, unknown>,
): EntrypointEnv {
  const result = EntrypointEnvSchema.safeParse(pickEntrypointEnvFields(input));
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid sandbox env: ${detail}`);
  }
  return result.data;
}
