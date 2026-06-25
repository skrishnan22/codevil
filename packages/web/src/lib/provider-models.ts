import {
  agentRunnableModelIds,
  buildProviderModelOptions,
  getProviderDefinition,
  MODELS_DEV_CATALOG_URL,
  type ModelsDevCatalog,
  type ProviderModelOption,
} from "@codevil/shared";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

type FetchFn = typeof globalThis.fetch;

export async function listProviderModels(
  providerId: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<ProviderModelOption[]> {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const catalog = await fetchModelsDevCatalog(fetcher);
  const availableIds = definition.id === "opencode-go"
    ? await fetchOpenCodeGoModelIds(fetcher)
    : undefined;
  const runnableIds = agentRunnableModelIds(providerId);

  return buildProviderModelOptions(providerId, catalog, availableIds, runnableIds);
}

async function fetchModelsDevCatalog(fetcher: FetchFn): Promise<ModelsDevCatalog> {
  const response = await fetcher(MODELS_DEV_CATALOG_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`models.dev catalog request failed: ${response.status}`);
  }

  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("models.dev catalog response was not an object");
  }

  return body as ModelsDevCatalog;
}

async function fetchOpenCodeGoModelIds(fetcher: FetchFn): Promise<ReadonlySet<string> | undefined> {
  try {
    const response = await fetcher(OPENCODE_GO_MODELS_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return undefined;

    const body = await response.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) return undefined;

    return new Set(
      body.data
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  } catch {
    return undefined;
  }
}
