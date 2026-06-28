import type { ParticipantIdentity, SessionState } from "@codevil/shared";

import type { Sandbox } from "@cloudflare/sandbox";

export type { SessionMeta } from "@codevil/shared";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  BACKUP_BUCKET?: R2Bucket;
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
  GITHUB_PAT?: string;
  CODEVIL_PREVIEW_ORIGIN?: string;
}

export interface InitOptions {
  worker_url: string;
  provider?: string;
  plan_model?: string;
  exec_model?: string;
  max_time?: string;
  created_by?: ParticipantIdentity;
}

export const SNAPSHOT_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_run_completed",
  "agent_run_failed",
  "room_ready",
  "complete",
  "verification_failed",
]);

export const PHASE_SPAN_NAMES: Partial<Record<SessionState, string>> = {
  planning: "phase.plan",
  refining: "phase.refine",
  executing: "phase.execute",
  verifying: "phase.verify",
  creating_pr: "phase.create_pr",
};
