import type { Orchestrator } from "./orchestrator.js";

export interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  CODEVIL_API_KEY: string;
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
