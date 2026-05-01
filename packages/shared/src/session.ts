export type SessionState =
  | "initializing"
  | "provisioning_sandbox"
  | "cloning_repo"
  | "planning"
  | "awaiting_approval"
  | "refining"
  | "executing"
  | "verifying"
  | "retrying"
  | "creating_pr"
  | "completed"
  | "failed"
  | "timed_out"
  | "cost_exceeded";

export type TerminalState = "completed" | "failed" | "timed_out" | "cost_exceeded";

const transitions: Record<SessionState, readonly SessionState[]> = {
  initializing: ["provisioning_sandbox", "failed"],
  provisioning_sandbox: ["cloning_repo", "failed", "timed_out", "cost_exceeded"],
  cloning_repo: ["planning", "failed", "timed_out", "cost_exceeded"],
  planning: ["awaiting_approval", "failed", "timed_out", "cost_exceeded"],
  awaiting_approval: ["refining", "executing", "failed", "timed_out", "cost_exceeded"],
  refining: ["awaiting_approval", "failed", "timed_out", "cost_exceeded"],
  executing: ["verifying", "failed", "timed_out", "cost_exceeded"],
  verifying: ["retrying", "creating_pr", "failed", "timed_out", "cost_exceeded"],
  retrying: ["verifying", "failed", "timed_out", "cost_exceeded"],
  creating_pr: ["completed", "failed", "timed_out", "cost_exceeded"],
  completed: [],
  failed: [],
  timed_out: [],
  cost_exceeded: [],
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  return transitions[from].includes(to);
}

export function isTerminalState(state: SessionState): state is TerminalState {
  return transitions[state].length === 0;
}

export const MAX_REFINEMENT_ROUNDS = 5;
export const MAX_VERIFICATION_ATTEMPTS = 5;
