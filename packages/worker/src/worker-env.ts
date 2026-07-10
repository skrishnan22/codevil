import { LLM_PROVIDER_CAPABILITIES, type WorkerProviderSecretName } from "@codevil/shared";

import type { Orchestrator } from "./orchestrator.js";

/** Credentials that must never cross a Worker diagnostic boundary unredacted. */
export type WorkerSecretEnv = Partial<Record<WorkerProviderSecretName, string>> & {
  CODEVIL_API_KEY?: string;
  CODEVIL_LLM_KEY?: string;
  GITHUB_PAT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CODEVIL_SETUP_TOKEN?: string;
  RESEND_API_KEY?: string;
  CODEVIL_PROXY_SIGNING_SECRET?: string;
};

/**
 * The one credential inventory for every Worker-owned diagnostic sink.
 * Keep this independent of feature-specific credential resolution so a new
 * provider secret is automatically covered through its shared capability.
 */
export function collectWorkerSecretValues(env: WorkerSecretEnv): string[] {
  return [...new Set([
    ...LLM_PROVIDER_CAPABILITIES.map((provider) => env[provider.secretName]),
    env.CODEVIL_LLM_KEY,
    env.CODEVIL_API_KEY,
    env.GITHUB_PAT,
    env.R2_ACCESS_KEY_ID,
    env.R2_SECRET_ACCESS_KEY,
    env.BETTER_AUTH_SECRET,
    env.GOOGLE_CLIENT_SECRET,
    env.CODEVIL_SETUP_TOKEN,
    env.RESEND_API_KEY,
    env.CODEVIL_PROXY_SIGNING_SECRET,
  ].map(normalizeSecret).filter((secret): secret is string => secret !== undefined))];
}

function normalizeSecret(value: string | undefined): string | undefined {
  const secret = value?.trim();
  return secret ? secret : undefined;
}

export interface Env extends WorkerSecretEnv {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace;
  DB: D1Database;
  BACKUP_BUCKET?: R2Bucket;
  ASSETS: Fetcher;
  CODEVIL_API_KEY: string;
  CODEVIL_PROXY_SIGNING_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  BACKUP_BUCKET_NAME?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CODEVIL_SETUP_TOKEN?: string;
  CODEVIL_WEB_ORIGIN?: string;
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  CODEVIL_APP_NAME?: string;
}
