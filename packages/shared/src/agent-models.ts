import type { LLMProviderId } from "./providers.js";

/**
 * Model IDs the sandbox Pi driver can resolve via @earendil-works/pi-ai.
 * Keep in sync with `codevil models list --provider opencode-go`.
 */
export const AGENT_RUNNABLE_MODEL_IDS: Partial<Record<LLMProviderId, readonly string[]>> = {
  "opencode-go": [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5.1",
    "glm-5.2",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "minimax-m2.7",
    "minimax-m3",
    "qwen3.6-plus",
    "qwen3.7-max",
    "qwen3.7-plus",
  ],
};

export function agentRunnableModelIds(providerId: string): ReadonlySet<string> | undefined {
  const ids = AGENT_RUNNABLE_MODEL_IDS[providerId as LLMProviderId];
  return ids ? new Set(ids) : undefined;
}
