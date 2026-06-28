import type {
  SessionState,
  DOToCLIEvent,
  DOToSandboxMessage,
  CostInfo,
  AgentRunState,
} from "@codevil/shared";
import type { Span, Tracer } from "@codevil/shared";
import type { AgentRun } from "../agent-runs.js";
import type { LastDecision } from "../multiplayer.js";
import type { Env, SessionMeta } from "./types.js";

export interface OrchestratorHost {
  meta: SessionMeta | null;
  sql: SqlStorage;
  workerEnv: Env;
  ctx: DurableObjectState;
  redactionSecrets: readonly string[];

  loadMeta(): void;
  saveMeta(): void;
  appendAndBroadcast(event: DOToCLIEvent): void;
  transition(to: SessionState): boolean;
  sendToSandbox(message: DOToSandboxMessage): void;
  trackCost(cost: CostInfo): void;
  updateDirectory(patch: {
    room_state?: string;
    sandbox_state?: string;
    active_run_state?: string | null;
  }): void;
  getTracer(): Tracer | null;
  currentPhaseSpan(): Span | undefined;
  freezePlanRevision(runId: string, round: number, markdown: string): void;
  lockPlanRevision(runId: string, round: number): void;
  consumeOpenAnnotations(runId: string, round: number): void;
  ensureAnnotatableRevision(runId: string, round: number): boolean;
  ensureActiveRun(runId?: string): boolean;
  setActiveRunState(state: AgentRunState): void;
  startAgentRun(run: AgentRun): void;
  finishRunAndDrainQueue(finalState: AgentRunState): void;
  failActiveRunAndReturnReady(message: string): void;
  completeActiveRun(prUrl?: string): void;
  cancelOpenQuestions(runId: string, reason: string): void;
  revokePreview(): void;
  recordDecision(decision: LastDecision): void;
  decisionRejection(
    attemptedAction: "approve" | "refine",
    fallbackMessage: string,
  ): { type: "error"; message: string; actor?: string };
  armNextAlarm(now?: number): Promise<void>;
}
