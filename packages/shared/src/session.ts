import { z } from "zod";

export const SessionStateSchema = z.enum([
  "initializing",
  "provisioning_sandbox",
  "cloning_repo",
  "ready",
  "planning",
  "awaiting_approval",
  "refining",
  "executing",
  "verifying",
  "retrying",
  "creating_pr",
  "completed",
  "failed",
  "timed_out",
]);

export type SessionState = z.infer<typeof SessionStateSchema>;

export const SESSION_STATES = SessionStateSchema.options;

export type TerminalState = "completed" | "failed" | "timed_out";

const transitions: Record<SessionState, readonly SessionState[]> = {
  initializing: ["provisioning_sandbox", "failed"],
  provisioning_sandbox: ["cloning_repo", "failed", "timed_out"],
  cloning_repo: ["ready", "planning", "failed", "timed_out"],
  ready: ["planning", "executing", "failed", "timed_out"],
  planning: ["awaiting_approval", "ready", "failed", "timed_out"],
  awaiting_approval: ["refining", "executing", "ready", "failed", "timed_out"],
  refining: ["awaiting_approval", "ready", "failed", "timed_out"],
  executing: ["verifying", "ready", "failed", "timed_out"],
  verifying: ["retrying", "creating_pr", "ready", "failed", "timed_out"],
  retrying: ["verifying", "failed", "timed_out"],
  creating_pr: ["ready", "completed", "failed", "timed_out"],
  completed: [],
  failed: [],
  timed_out: [],
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  return (transitions[from] ?? []).includes(to);
}

export function isTerminalState(state: SessionState): state is TerminalState {
  return (transitions[state] ?? []).length === 0;
}

export const MAX_REFINEMENT_ROUNDS = 5;
export const MAX_VERIFICATION_ATTEMPTS = 5;
