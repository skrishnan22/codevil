import type { AgentRunState, ParticipantIdentity } from "@codevil/shared";

export interface AgentRun {
  id: string;
  actor: ParticipantIdentity;
  text: string;
  state: AgentRunState;
  created_at: string;
}

export interface AgentRunQueueState {
  active: AgentRun | null;
  queue: AgentRun[];
}

export interface AgentRunQueueResult extends AgentRunQueueState {
  started?: AgentRun;
  queued?: { run: AgentRun; position: number };
}

export function createAgentRun(input: {
  actor: ParticipantIdentity;
  text: string;
  now: string;
  id?: string;
}): AgentRun {
  return {
    id: input.id ?? `run_${crypto.randomUUID().replace(/-/g, "")}`,
    actor: input.actor,
    text: input.text.trim(),
    state: "queued",
    created_at: input.now,
  };
}

export function enqueueAgentRun(state: AgentRunQueueState, run: AgentRun): AgentRunQueueResult {
  if (!state.active) {
    const started = startRun(run);
    return {
      active: started,
      queue: state.queue,
      started,
    };
  }

  const queue = [...state.queue, run];
  return {
    active: state.active,
    queue,
    queued: { run, position: queue.length },
  };
}

export function finishActiveAgentRun(state: AgentRunQueueState): AgentRunQueueResult {
  const [next, ...queue] = state.queue;
  if (!next) {
    return { active: null, queue };
  }

  const started = startRun(next);
  return {
    active: started,
    queue,
    started,
  };
}

export function startRun(run: AgentRun): AgentRun {
  return { ...run, state: "thinking" };
}
