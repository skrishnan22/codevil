import { getModels, type KnownProvider } from "@earendil-works/pi-ai/compat";
import { getProviderDefinition } from "@codevil/shared";

export interface AgentModelInfo {
  id: string;
  name: string;
  provider: string;
}

export function listAgentRunnableModels(providerId: string): AgentModelInfo[] {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const models = getModels(providerId as KnownProvider);
  return models
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      provider: providerId,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function checkAgentRunnableModel(providerId: string, modelId: string): boolean {
  try {
    return getModels(providerId as KnownProvider).some((model) => model.id === modelId);
  } catch {
    return false;
  }
}
