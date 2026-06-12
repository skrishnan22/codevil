export type SessionState =
  | "initializing"
  | "provisioning_sandbox"
  | "cloning_repo"
  | "ready"
  | "planning"
  | "awaiting_approval"
  | "awaiting_resolution"
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
  cloning_repo: ["ready", "planning", "failed", "timed_out", "cost_exceeded"],
  ready: ["planning", "executing", "failed", "timed_out", "cost_exceeded"],
  planning: ["awaiting_approval", "ready", "failed", "timed_out", "cost_exceeded"],
  awaiting_approval: ["refining", "executing", "ready", "failed", "timed_out", "cost_exceeded"],
  awaiting_resolution: ["refining", "executing", "failed", "timed_out", "cost_exceeded"],
  refining: ["awaiting_approval", "awaiting_resolution", "ready", "failed", "timed_out", "cost_exceeded"],
  executing: ["verifying", "ready", "failed", "timed_out", "cost_exceeded"],
  verifying: ["retrying", "creating_pr", "ready", "failed", "timed_out", "cost_exceeded"],
  retrying: ["verifying", "failed", "timed_out", "cost_exceeded"],
  creating_pr: ["ready", "completed", "failed", "timed_out", "cost_exceeded"],
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
