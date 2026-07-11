import type { AgentRun } from "@codevil/shared";

export type { AgentRun };

export interface AgentRunQueueState {
  active: AgentRun | null;
  queue: AgentRun[];
}

export interface AgentRunQueueResult extends AgentRunQueueState {
  started?: AgentRun;
  queued?: { run: AgentRun; position: number };
}

export interface EnqueueAgentRunOptions {
  /** When false, queue even with no active run (session not ready). Default true. */
  sessionReady?: boolean;
}

export function createAgentRun(input: {
  actor: AgentRun["actor"];
  text: string;
  now: string;
  id?: string;
  planFirst?: boolean;
}): AgentRun {
  return {
    id: input.id ?? `run_${crypto.randomUUID().replace(/-/g, "")}`,
    actor: input.actor,
    text: input.text.trim(),
    plan_first: input.planFirst ?? false,
    state: "queued",
    created_at: input.now,
  };
}

export function enqueueAgentRun(
  state: AgentRunQueueState,
  run: AgentRun,
  options: EnqueueAgentRunOptions = {},
): AgentRunQueueResult {
  const sessionReady = options.sessionReady ?? true;

  if (!state.active && !sessionReady) {
    const queue = [...state.queue, run];
    return {
      active: null,
      queue,
      queued: { run, position: queue.length },
    };
  }

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
