import { z } from "zod";

import {
  AgentRunSchema,
  ParticipantIdentitySchema,
} from "./room.js";
import { SessionStateSchema } from "./session.js";

export const LastDecisionSchema = z.object({
  actor: z.string(),
  action: z.enum(["approve", "refine"]),
  refinement_round: z.number().int().nonnegative(),
});

export const SessionMetaSchema = z.object({
  session_id: z.string(),
  prompt: z.string(),
  repo: z.string(),
  worker_url: z.string(),
  provider: z.string(),
  plan_model: z.string(),
  exec_model: z.string(),
  max_time: z.string(),
  state: SessionStateSchema,
  refinement_round: z.number().int().nonnegative(),
  verification_attempts: z.number().int().nonnegative(),
  cost_total_usd: z.number(),
  latest_plan: z.string().optional(),
  active_run: AgentRunSchema.nullable().optional(),
  queued_runs: z.array(AgentRunSchema).default([]),
  created_by: ParticipantIdentitySchema.optional(),
  preview_token_hash: z.string().optional(),
  preview_url: z.string().optional(),
  preview_port: z.number().optional(),
  preview_active: z.boolean().optional(),
  created_at: z.string(),
  expected_close: z.boolean().optional(),
  sandbox_disconnected_at: z.string().optional(),
  workspace_cache_restored: z.boolean().optional(),
  last_decision: LastDecisionSchema.optional(),
});

export type SessionMeta = z.infer<typeof SessionMetaSchema>;
export type LastDecision = z.infer<typeof LastDecisionSchema>;
