import { getProviderDefinition, LLM_PROVIDERS } from "@codevil/shared";

export interface ProviderCredentialEnv {
  OPENCODE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEVIL_LLM_KEY?: string;
}

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

  switch (definition.secretName) {
    case "OPENCODE_API_KEY":
      return normalizeCredential(env.OPENCODE_API_KEY) ?? legacy;
    case "OPENROUTER_API_KEY":
      return normalizeCredential(env.OPENROUTER_API_KEY) ?? legacy;
    case "OPENAI_API_KEY":
      return normalizeCredential(env.OPENAI_API_KEY) ?? legacy;
  }
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

export function collectProviderCredentialSecrets(env: ProviderCredentialEnv): string[] {
  return [...new Set(
    [
      ...LLM_PROVIDERS.map((provider) => env[provider.secretName]),
      env.CODEVIL_LLM_KEY,
    ]
      .map(normalizeCredential)
      .filter((secret): secret is string => secret !== undefined),
  )];
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim() === "" ? undefined : value;
}
