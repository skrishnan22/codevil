import type { LLMProviderId } from "./providers.js";

/**
 * Model IDs the sandbox pi-driver can resolve via @mariozechner/pi-ai.
 * Keep in sync with `codevil models list --provider opencode-go`.
 */
export const AGENT_RUNNABLE_MODEL_IDS: Partial<Record<LLMProviderId, readonly string[]>> = {
  "opencode-go": [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5",
    "glm-5.1",
    "kimi-k2.5",
    "kimi-k2.6",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "minimax-m2.5",
    "minimax-m2.7",
    "qwen3.5-plus",
    "qwen3.6-plus",
  ],
};

export function agentRunnableModelIds(providerId: string): ReadonlySet<string> | undefined {
  const ids = AGENT_RUNNABLE_MODEL_IDS[providerId as LLMProviderId];
  return ids ? new Set(ids) : undefined;
}
