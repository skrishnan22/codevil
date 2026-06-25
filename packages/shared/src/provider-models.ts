import type { LLMProviderId } from "./providers.js";

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";

export const PROVIDERS_WITH_MODEL_CATALOG: readonly LLMProviderId[] = ["opencode-go"];

const MODELS_DEV_PROVIDER_BY_CODEVIL_ID: Partial<Record<LLMProviderId, string>> = {
  "opencode-go": "opencode-go",
};

export interface ProviderModelOption {
  id: string;
  name: string;
}

export interface ModelsDevProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly models: Record<string, { readonly id: string; readonly name: string }>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

export function modelsDevProviderKey(providerId: string): string | undefined {
  if (!PROVIDERS_WITH_MODEL_CATALOG.includes(providerId as LLMProviderId)) {
    return undefined;
  }
  return MODELS_DEV_PROVIDER_BY_CODEVIL_ID[providerId as LLMProviderId];
}

export function buildProviderModelOptions(
  providerId: string,
  catalog: ModelsDevCatalog,
  availableIds?: ReadonlySet<string>,
  runnableIds?: ReadonlySet<string>,
): ProviderModelOption[] {
  const modelsDevKey = modelsDevProviderKey(providerId);
  if (!modelsDevKey) {
    throw new Error(`Provider model catalog is not supported: ${providerId}`);
  }

  const providerEntry = catalog[modelsDevKey];
  if (!providerEntry?.models) {
    return [];
  }

  const catalogIds = Object.keys(providerEntry.models);
  let ids = catalogIds;

  if (availableIds && availableIds.size > 0) {
    ids = ids.filter((id) => availableIds.has(id));
  }

  if (runnableIds && runnableIds.size > 0) {
    ids = ids.filter((id) => runnableIds.has(id));
  }

  const extras = availableIds
    ? [...availableIds].filter((id) => {
      if (catalogIds.includes(id)) return false;
      if (runnableIds && runnableIds.size > 0 && !runnableIds.has(id)) return false;
      return true;
    })
    : [];

  return [...ids, ...extras]
    .map((id) => ({
      id,
      name: providerEntry.models[id]?.name ?? formatModelId(id),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatModelId(modelId: string): string {
  return modelId
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
