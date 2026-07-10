import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type CostInfo, zeroCost } from "@codevil/shared";

interface SessionCostSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function snapshotSessionCost(session: AgentSession): SessionCostSnapshot {
  const stats = session.getSessionStats();
  return {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    costUsd: stats.cost,
  };
}

export function costSinceSnapshot(before: SessionCostSnapshot, after: SessionCostSnapshot): CostInfo {
  return {
    input_tokens: Math.max(0, after.inputTokens - before.inputTokens),
    output_tokens: Math.max(0, after.outputTokens - before.outputTokens),
    total_cost_usd: Number(Math.max(0, after.costUsd - before.costUsd).toFixed(6)),
  };
}

export function costFromSessionStats(session: AgentSession): CostInfo {
  const stats = session.getSessionStats();
  return {
    input_tokens: stats.tokens.input,
    output_tokens: stats.tokens.output,
    total_cost_usd: Number(stats.cost.toFixed(6)),
  };
}

export function emptySessionCostSnapshot(): SessionCostSnapshot {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export { zeroCost };
