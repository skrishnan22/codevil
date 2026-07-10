import { z } from "zod";

import type { ProviderPublicConfig } from "./providers.js";

const ProviderPublicConfigSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  CLOUDFLARE_GATEWAY_ID: z.string().min(1).optional(),
}).strict();

export const EntrypointEnvSchema = z.object({
  CODEVIL_DO_WS_URL: z.string().min(1).optional(),
  CODEVIL_SANDBOX_WS_TOKEN: z.string().min(1).optional(),
  CODEVIL_WORKSPACE: z.string().optional(),
  CODEVIL_PROVIDER: z.string().optional(),
  CODEVIL_PROVIDER_CONFIG: z.string().min(1).optional(),
  CODEVIL_PROXY_BASE: z.string().url().optional(),
  CODEVIL_PROXY_TOKENS: z.string().min(1).optional(),
});

export type EntrypointEnv = z.infer<typeof EntrypointEnvSchema>;

const ENTRYPOINT_ENV_KEYS = [
  "CODEVIL_DO_WS_URL",
  "CODEVIL_SANDBOX_WS_TOKEN",
  "CODEVIL_WORKSPACE",
  "CODEVIL_PROVIDER",
  "CODEVIL_PROVIDER_CONFIG",
  "CODEVIL_PROXY_BASE",
  "CODEVIL_PROXY_TOKENS",
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

/** Parse the small, allowlisted config payload passed to Pi; never arbitrary env. */
export function parseProviderPublicConfig(raw: string | undefined): ProviderPublicConfig {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid provider configuration JSON");
  }
  const result = ProviderPublicConfigSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid provider configuration");
  return result.data;
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
