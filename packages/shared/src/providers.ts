import { z } from "zod";

export type LLMProviderId = "opencode-go" | "openrouter" | "openai";

type ProviderSecretNameById = {
  readonly "opencode-go": "OPENCODE_API_KEY";
  readonly openrouter: "OPENROUTER_API_KEY";
  readonly openai: "OPENAI_API_KEY";
};

type ProviderAliasesById = {
  readonly "opencode-go": readonly ["opencode"];
  readonly openrouter: readonly [];
  readonly openai: readonly [];
};

export type LLMProviderDefinition = {
  [K in LLMProviderId]: {
    readonly id: K;
    readonly aliases: ProviderAliasesById[K];
    readonly displayName: string;
    readonly secretName: ProviderSecretNameById[K];
    readonly validationUrl: string;
    readonly keyHelpUrl: string;
  };
}[LLMProviderId];

export const LLM_PROVIDERS = [
  {
    id: "opencode-go",
    aliases: ["opencode"],
    displayName: "OpenCode Go",
    secretName: "OPENCODE_API_KEY",
    validationUrl: "https://opencode.ai/zen/go/v1/models",
    keyHelpUrl: "https://opencode.ai/docs/go/",
  },
  {
    id: "openrouter",
    aliases: [],
    displayName: "OpenRouter",
    secretName: "OPENROUTER_API_KEY",
    validationUrl: "https://openrouter.ai/api/v1/key",
    keyHelpUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "openai",
    aliases: [],
    displayName: "OpenAI Platform",
    secretName: "OPENAI_API_KEY",
    validationUrl: "https://api.openai.com/v1/models",
    keyHelpUrl: "https://platform.openai.com/api-keys",
  },
] as const satisfies readonly LLMProviderDefinition[];

export const LLMProviderIdSchema = z.enum(["opencode-go", "openrouter", "openai"]);

/** Accepts canonical provider ids and documented aliases (e.g. `opencode` → `opencode-go`). */
export const KnownProviderSchema = z
  .string()
  .trim()
  .min(1)
  .refine((provider) => getProviderDefinition(provider) !== undefined, {
    message: "Unknown LLM provider",
  });

export function getProviderDefinition(
  provider: string,
): LLMProviderDefinition | undefined {
  return LLM_PROVIDERS.find((definition) => {
    switch (definition.id) {
      case "opencode-go":
        return provider === "opencode-go" || provider === "opencode";
      case "openrouter":
        return provider === "openrouter";
      case "openai":
        return provider === "openai";
    }
  });
}
