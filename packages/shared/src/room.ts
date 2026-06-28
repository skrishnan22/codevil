import { z } from "zod";

export const RoomStateSchema = z.enum([
  "initializing",
  "ready",
  "failed",
  "archived",
]);

export const SandboxStateSchema = z.enum([
  "not_started",
  "provisioning",
  "cloning",
  "ready",
  "stopping",
  "stopped",
  "timed_out",
  "failed",
]);

export const AgentRunStateSchema = z.enum([
  "queued",
  "thinking",
  "awaiting_approval",
  "executing",
  "verifying",
  "publishing",
  "completed",
  "failed",
  "cancelled",
]);

export const ParticipantIdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const AgentRunSchema = z.object({
  id: z.string(),
  actor: ParticipantIdentitySchema,
  text: z.string(),
  plan_first: z.boolean(),
  state: AgentRunStateSchema,
  created_at: z.string(),
});

export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  room_state: RoomStateSchema,
  sandbox_state: SandboxStateSchema,
  active_run_state: AgentRunStateSchema.optional(),
  created_by: ParticipantIdentitySchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
  last_event_at: z.string(),
});

export const CreateSessionRequestSchema = z.object({
  repo: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
  plan_model: z.string().trim().min(1).optional(),
  exec_model: z.string().trim().min(1).optional(),
  max_session_time: z.string().trim().min(1).optional(),
  max_idle_time: z.string().trim().min(1).optional(),
  created_by: ParticipantIdentitySchema.optional(),
}).strict();

export const CreateSessionResponseSchema = z.object({
  session_id: z.string(),
  ws_url: z.string(),
  summary: SessionSummarySchema,
});

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});

export const GetSessionResponseSchema = z.object({
  session: SessionSummarySchema,
  ws_url: z.string(),
});

export type RoomState = z.infer<typeof RoomStateSchema>;
export type SandboxState = z.infer<typeof SandboxStateSchema>;
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type ParticipantIdentity = z.infer<typeof ParticipantIdentitySchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;
export type GetSessionResponse = z.infer<typeof GetSessionResponseSchema>;
