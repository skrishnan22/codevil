import {
  getProviderDefinition,
  LLM_PROVIDER_CAPABILITIES,
  type ProviderPublicConfig,
  type ProviderPublicConfigKey,
  type WorkerProviderSecretName,
} from "@codevil/shared";

export type ProviderCredentialEnv = Partial<Record<WorkerProviderSecretName, string>> & {
  CODEVIL_LLM_KEY?: string;
} & Partial<Record<ProviderPublicConfigKey, string>>;

export interface ProvisioningCredentialContext {
  llmKey: string;
  hasLlmKey: boolean;
}

export function resolveProviderCredential(
  env: ProviderCredentialEnv,
  provider: string,
): string | undefined {
  const legacy = normalizeCredential(env.CODEVIL_LLM_KEY);
  const definition = getProviderDefinition(provider);
  if (!definition) return legacy;

  return normalizeCredential(env[definition.secretName]) ?? legacy;
}

export function requireProviderCredential(
  env: ProviderCredentialEnv,
  provider: string,
): string {
  const credential = resolveProviderCredential(env, provider);
  if (credential) return credential;

  const providerName = getProviderDefinition(provider)?.displayName ?? provider;
  throw new Error(`${providerName} is not configured. Run \`pnpm providers\` on the Codevil host.`);
}

export function getProvisioningCredentialContext(
  env: ProviderCredentialEnv,
  provider: string,
): ProvisioningCredentialContext {
  const llmKey = requireProviderCredential(env, provider);
  return {
    llmKey,
    hasLlmKey: true,
  };
}

/**
 * Return only registry-declared non-secret configuration for a provider.
 * Required values fail before the sandbox starts, rather than leaving Pi to
 * issue requests containing unresolved URL placeholders.
 */
export function requireProviderPublicConfig(
  env: ProviderCredentialEnv,
  provider: string,
): ProviderPublicConfig {
  const definition = getProviderDefinition(provider);
  if (!definition) throw new Error("Unsupported LLM provider");

  const config: ProviderPublicConfig = {};
  const missing: string[] = [];
  for (const key of definition.configKeys) {
    const value = normalizeCredential(env[key]);
    if (!value) missing.push(key);
    else config[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`${definition.displayName} is missing required configuration: ${missing.join(", ")}`);
  }
  return config;
}

export function collectProviderCredentialSecrets(env: ProviderCredentialEnv): string[] {
  return [...new Set(
    [
      ...LLM_PROVIDER_CAPABILITIES.map((provider) => env[provider.secretName]),
      env.CODEVIL_LLM_KEY,
    ]
      .map(normalizeCredential)
      .filter((secret): secret is string => secret !== undefined),
  )];
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}
