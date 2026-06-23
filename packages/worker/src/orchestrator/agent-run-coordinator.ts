import type { AgentRunState } from "@codevil/shared";
import { isValidTransition } from "@codevil/shared";
import {
  finishActiveAgentRun,
  type AgentRun,
} from "../agent-runs.js";
import { describeDecisionRejection, type LastDecision } from "../multiplayer.js";
import type { OrchestratorHost } from "./host.js";

export function ensureActiveRun(host: OrchestratorHost, runId?: string): boolean {
  if (!host.meta) return false;
  const active = host.meta.active_run;
  if (!active) {
    host.appendAndBroadcast({ type: "error", message: "No active agent run." });
    return false;
  }
  if (runId && active.id !== runId) {
    host.appendAndBroadcast({
      type: "error",
      message: `Run ${runId} is not active.`,
    });
    return false;
  }
  return true;
}

export function setActiveRunState(host: OrchestratorHost, state: AgentRunState): void {
  if (!host.meta?.active_run) return;
  host.meta.active_run = { ...host.meta.active_run, state };
  host.saveMeta();
  host.updateDirectory({ active_run_state: state });
}

export function startAgentRun(host: OrchestratorHost, run: AgentRun): void {
  if (!host.meta) return;

  host.meta.active_run = run;
  host.meta.prompt = run.text;
  host.meta.latest_plan = undefined;
  host.meta.refinement_round = 0;
  host.meta.verification_attempts = 0;
  host.meta.last_decision = undefined;
  host.saveMeta();

  if (host.meta.state !== "ready") {
    host.appendAndBroadcast({
      type: "agent_run_failed",
      run_id: run.id,
      message: `Cannot start agent run in state: ${host.meta.state}`,
    });
    finishRunAndDrainQueue(host, "failed");
    return;
  }

  if (run.plan_first) {
    if (!host.transition("planning")) {
      failActiveRunAndReturnReady(host, `Cannot start agent run in state: ${host.meta.state}`);
      return;
    }

    setActiveRunState(host, "thinking");
    host.appendAndBroadcast({
      type: "agent_run_started",
      run_id: run.id,
      actor: run.actor,
      text: run.text,
    });
    host.appendAndBroadcast({
      type: "phase",
      phase: "planning",
      model: host.meta.plan_model,
    });
    host.sendToSandbox({
      type: "plan",
      run_id: run.id,
      prompt: run.text,
      model: host.meta.plan_model,
      provider: host.meta.provider,
    });
    return;
  }

  if (!host.transition("executing")) {
    failActiveRunAndReturnReady(host, `Cannot start agent run in state: ${host.meta.state}`);
    return;
  }

  setActiveRunState(host, "executing");
  host.appendAndBroadcast({
    type: "agent_run_started",
    run_id: run.id,
    actor: run.actor,
    text: run.text,
  });
  host.appendAndBroadcast({
    type: "phase",
    phase: "executing",
    model: host.meta.exec_model,
  });
  host.sendToSandbox({
    type: "agent_turn",
    run_id: run.id,
    prompt: run.text,
    model: host.meta.exec_model,
    provider: host.meta.provider,
  });
}

export function finishRunAndDrainQueue(host: OrchestratorHost, finalState: AgentRunState): void {
  if (!host.meta) return;
  if (host.meta.active_run) {
    host.meta.active_run = { ...host.meta.active_run, state: finalState };
  }
  const next = finishActiveAgentRun({
    active: host.meta.active_run ?? null,
    queue: host.meta.queued_runs,
  });
  host.meta.active_run = next.active;
  host.meta.queued_runs = next.queue;
  host.saveMeta();
  host.updateDirectory({ active_run_state: next.active?.state ?? null });

  if (next.started) {
    startAgentRun(host, next.started);
  }
}

export function failActiveRunAndReturnReady(host: OrchestratorHost, message: string): void {
  if (!host.meta?.active_run) return;
  const runId = host.meta.active_run.id;
  host.appendAndBroadcast({
    type: "agent_run_failed",
    run_id: runId,
    message,
  });
  if (host.meta.state !== "ready" && isValidTransition(host.meta.state, "ready")) {
    host.transition("ready");
  }
  finishRunAndDrainQueue(host, "failed");
}

export function completeActiveRun(host: OrchestratorHost, prUrl?: string): void {
  if (!host.meta?.active_run) return;
  const runId = host.meta.active_run.id;

  if (host.meta.state !== "ready" && isValidTransition(host.meta.state, "ready")) {
    host.transition("ready");
  }
  host.appendAndBroadcast({
    type: "agent_run_completed",
    run_id: runId,
    ...(prUrl ? { pr_url: prUrl } : {}),
  });
  finishRunAndDrainQueue(host, "completed");
}

// Persist the most recent plan decision so a later, rejected decision can name
// whoever already acted on this plan.
export function recordDecision(host: OrchestratorHost, decision: LastDecision): void {
  if (!host.meta) return;
  host.meta.last_decision = decision;
  host.saveMeta();
}

// Build an attributed rejection event for a too-late plan decision, falling
// back to the generic state-only message when no same-round decider is known.
export function decisionRejection(
  host: OrchestratorHost,
  attemptedAction: "approve" | "refine",
  fallbackMessage: string,
): { type: "error"; message: string; actor?: string } {
  const attribution = host.meta
    ? describeDecisionRejection(attemptedAction, host.meta.last_decision ?? null, host.meta.refinement_round)
    : null;
  if (attribution) {
    return { type: "error", message: attribution.message, actor: attribution.actor };
  }
  return { type: "error", message: fallbackMessage };
}
