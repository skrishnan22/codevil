import type { Orchestrator } from "./orchestrator.js";

export interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace;
  DB: D1Database;
  BACKUP_BUCKET?: R2Bucket;
  ASSETS: Fetcher;
  CODEVIL_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  BACKUP_BUCKET_NAME?: string;
  OPENCODE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEVIL_LLM_KEY?: string;
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
