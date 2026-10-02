import { z } from "zod";

/** API protocols emitted by Pi providers that Codevil can credential through an outbound proxy. */
export const PROVIDER_APIS = [
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "openai-completions",
  "openai-responses",
] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

export type ProviderAuthPolicy = {
  readonly api: ProviderApi;
  readonly header: "authorization" | "cf-aig-authorization" | "x-api-key" | "x-goog-api-key";
  readonly prefix: "" | "Bearer ";
};

/** Secrets that an operator may configure for an API-key backed Pi provider. */
export type WorkerProviderSecretName =
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "GEMINI_API_KEY"
  | "DEEPSEEK_API_KEY"
  | "NVIDIA_API_KEY"
  | "MISTRAL_API_KEY"
  | "GROQ_API_KEY"
  | "CEREBRAS_API_KEY"
  | "XAI_API_KEY"
  | "OPENROUTER_API_KEY"
  | "TOGETHER_API_KEY"
  | "HF_TOKEN"
  | "MOONSHOT_API_KEY"
  | "ZAI_API_KEY"
  | "ZAI_CODING_CN_API_KEY"
  | "MINIMAX_API_KEY"
  | "MINIMAX_CN_API_KEY"
  | "XIAOMI_API_KEY"
  | "XIAOMI_TOKEN_PLAN_CN_API_KEY"
  | "XIAOMI_TOKEN_PLAN_AMS_API_KEY"
  | "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
  | "ANT_LING_API_KEY"
  | "KIMI_API_KEY"
  | "AI_GATEWAY_API_KEY"
  | "FIREWORKS_API_KEY"
  | "OPENCODE_API_KEY"
  | "CLOUDFLARE_API_KEY";

/** Non-secret values needed by the outbound provider proxy. */
export type ProviderPublicConfigKey = "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_GATEWAY_ID";

/**
 * Non-secret provider values that may cross the Worker-to-sandbox boundary.
 * This deliberately cannot represent arbitrary process environment variables.
 */
export type ProviderPublicConfig = Partial<Record<ProviderPublicConfigKey, string>>;

// Pi providers deliberately deferred until their non-API-key credential flow is
// implemented (asserted against KnownProviderSchema in providers.test.mjs):
// azure-openai-responses, google-vertex, amazon-bedrock, openai-codex,
// github-copilot, anthropic-oauth, custom.

type ProviderCapabilityShape = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly displayName: string;
  /** Worker secret used by the outbound proxy. */
  readonly secretName: WorkerProviderSecretName;
  /** Exact network authorities Pi 0.80.3 models send requests to. */
  readonly hosts: readonly string[];
  /** Header replacement rules indexed by Pi's model API protocol. */
  readonly authPolicies: readonly ProviderAuthPolicy[];
  /** Required provider configuration that is not itself secret material. */
  readonly configKeys: readonly ProviderPublicConfigKey[];
};

const openAICompletions = auth("openai-completions", "authorization", "Bearer ");
const openAIResponses = auth("openai-responses", "authorization", "Bearer ");
const anthropicMessages = auth("anthropic-messages", "x-api-key", "");
const googleGenerativeAI = auth("google-generative-ai", "x-goog-api-key", "");
const mistralConversations = auth("mistral-conversations", "authorization", "Bearer ");
const cloudflareAIGatewayAnthropic = auth("anthropic-messages", "cf-aig-authorization", "Bearer ");
const cloudflareAIGatewayOpenAICompletions = auth("openai-completions", "cf-aig-authorization", "Bearer ");
const cloudflareAIGatewayOpenAIResponses = auth("openai-responses", "cf-aig-authorization", "Bearer ");

/**
 * This registry is the security boundary for API-key backed Pi 0.80.3 providers.
 * OAuth, cloud identity, and arbitrary endpoints are intentionally absent.
 */
export const LLM_PROVIDER_CAPABILITIES = [
  capability("openai", "OpenAI", "OPENAI_API_KEY", ["api.openai.com"], [openAIResponses]),
  capability("anthropic", "Anthropic", "ANTHROPIC_API_KEY", ["api.anthropic.com"], [anthropicMessages]),
  capability("google", "Google", "GEMINI_API_KEY", ["generativelanguage.googleapis.com"], [googleGenerativeAI]),
  capability("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", ["api.deepseek.com"], [openAICompletions]),
  capability("nvidia", "NVIDIA", "NVIDIA_API_KEY", ["integrate.api.nvidia.com"], [openAICompletions]),
  capability("mistral", "Mistral", "MISTRAL_API_KEY", ["api.mistral.ai"], [mistralConversations]),
  capability("groq", "Groq", "GROQ_API_KEY", ["api.groq.com"], [openAICompletions]),
  capability("cerebras", "Cerebras", "CEREBRAS_API_KEY", ["api.cerebras.ai"], [openAICompletions]),
  capability("xai", "xAI", "XAI_API_KEY", ["api.x.ai"], [openAICompletions]),
  capability("openrouter", "OpenRouter", "OPENROUTER_API_KEY", ["openrouter.ai"], [openAICompletions]),
  capability("together", "Together", "TOGETHER_API_KEY", ["api.together.ai"], [openAICompletions]),
  capability("huggingface", "Hugging Face", "HF_TOKEN", ["router.huggingface.co"], [openAICompletions]),
  capability("moonshotai", "Moonshot AI", "MOONSHOT_API_KEY", ["api.moonshot.ai"], [openAICompletions]),
  capability("moonshotai-cn", "Moonshot AI CN", "MOONSHOT_API_KEY", ["api.moonshot.cn"], [openAICompletions]),
  capability("zai", "Z.AI", "ZAI_API_KEY", ["api.z.ai"], [openAICompletions]),
  capability("zai-coding-cn", "Z.AI Coding CN", "ZAI_CODING_CN_API_KEY", ["open.bigmodel.cn"], [openAICompletions]),
  capability("minimax", "MiniMax", "MINIMAX_API_KEY", ["api.minimax.io"], [anthropicMessages]),
  capability("minimax-cn", "MiniMax CN", "MINIMAX_CN_API_KEY", ["api.minimaxi.com"], [anthropicMessages]),
  capability("xiaomi", "Xiaomi", "XIAOMI_API_KEY", ["api.xiaomimimo.com"], [openAICompletions]),
  capability("xiaomi-token-plan-cn", "Xiaomi Token Plan CN", "XIAOMI_TOKEN_PLAN_CN_API_KEY", ["token-plan-cn.xiaomimimo.com"], [openAICompletions]),
  capability("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", ["token-plan-ams.xiaomimimo.com"], [openAICompletions]),
  capability("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", ["token-plan-sgp.xiaomimimo.com"], [openAICompletions]),
  capability("ant-ling", "Ant Ling", "ANT_LING_API_KEY", ["api.ant-ling.com"], [openAICompletions]),
  capability("kimi-coding", "Kimi For Coding", "KIMI_API_KEY", ["api.kimi.com"], [anthropicMessages]),
  capability("vercel-ai-gateway", "Vercel AI Gateway", "AI_GATEWAY_API_KEY", ["ai-gateway.vercel.sh"], [anthropicMessages]),
  capability("fireworks", "Fireworks", "FIREWORKS_API_KEY", ["api.fireworks.ai"], [anthropicMessages, openAICompletions]),
  capability("opencode", "OpenCode Zen", "OPENCODE_API_KEY", ["opencode.ai"], [anthropicMessages, googleGenerativeAI, openAICompletions, openAIResponses]),
  capability("opencode-go", "OpenCode Zen Go", "OPENCODE_API_KEY", ["opencode.ai"], [anthropicMessages, openAICompletions]),
  capability("cloudflare-workers-ai", "Cloudflare Workers AI", "CLOUDFLARE_API_KEY", ["api.cloudflare.com"], [openAICompletions], ["CLOUDFLARE_ACCOUNT_ID"]),
  capability("cloudflare-ai-gateway", "Cloudflare AI Gateway", "CLOUDFLARE_API_KEY", ["gateway.ai.cloudflare.com"], [cloudflareAIGatewayAnthropic, cloudflareAIGatewayOpenAICompletions, cloudflareAIGatewayOpenAIResponses], ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]),
] as const satisfies readonly ProviderCapabilityShape[];

/** Canonical provider ids are derived from the outbound capability security boundary. */
export type LLMProviderId = (typeof LLM_PROVIDER_CAPABILITIES)[number]["id"];
export type LLMProviderCapability = (typeof LLM_PROVIDER_CAPABILITIES)[number];

/** Backwards-compatible runtime export, derived rather than maintained separately. */
export const LLM_PROVIDER_IDS = LLM_PROVIDER_CAPABILITIES.map(
  (provider) => provider.id,
) as unknown as readonly [LLMProviderId, ...LLMProviderId[]];

function auth(
  api: ProviderApi,
  header: ProviderAuthPolicy["header"],
  prefix: ProviderAuthPolicy["prefix"],
): ProviderAuthPolicy {
  return { api, header, prefix };
}

function capability<
  const Id extends string,
  const Hosts extends readonly string[],
  const Policies extends readonly ProviderAuthPolicy[],
  const ConfigKeys extends readonly ProviderPublicConfigKey[],
  const Aliases extends readonly string[],
>(
  id: Id,
  displayName: string,
  secretName: WorkerProviderSecretName,
  hosts: Hosts,
  authPolicies: Policies,
  configKeys: ConfigKeys = [] as unknown as ConfigKeys,
  aliases: Aliases = [] as unknown as Aliases,
): ProviderCapabilityShape & {
  readonly id: Id;
  readonly hosts: Hosts;
  readonly authPolicies: Policies;
  readonly configKeys: ConfigKeys;
  readonly aliases: Aliases;
} {
  return { id, aliases, displayName, secretName, hosts, authPolicies, configKeys };
}

export type LLMProviderDefinition = Pick<
  LLMProviderCapability,
  "id" | "aliases" | "displayName" | "secretName" | "configKeys"
> & {
  /** A safe, provider-specific request for checking an API key. Omitted means save without live validation. */
  readonly validation?: {
    readonly url: string;
    readonly header: "authorization" | "x-api-key" | "x-goog-api-key";
    readonly prefix: "" | "Bearer ";
  };
};

const PROVIDER_VALIDATION = {
  openai: { url: "https://api.openai.com/v1/models", header: "authorization", prefix: "Bearer " },
  openrouter: { url: "https://openrouter.ai/api/v1/key", header: "authorization", prefix: "Bearer " },
  opencode: { url: "https://opencode.ai/zen/v1/models", header: "authorization", prefix: "Bearer " },
  "opencode-go": { url: "https://opencode.ai/zen/go/v1/models", header: "authorization", prefix: "Bearer " },
} as const;

/** Operator setup is derived from the same allowlisted capabilities used by the outbound proxy. */
export const LLM_PROVIDERS = LLM_PROVIDER_CAPABILITIES.map((provider) => ({
  id: provider.id,
  aliases: provider.aliases,
  displayName: provider.displayName,
  secretName: provider.secretName,
  configKeys: provider.configKeys,
  validation: PROVIDER_VALIDATION[provider.id as keyof typeof PROVIDER_VALIDATION],
})) as readonly LLMProviderDefinition[];

export const LLMProviderIdSchema = z.enum(LLM_PROVIDER_IDS);

/** Accepts supported canonical Pi provider ids. */
export const KnownProviderSchema = z
  .string()
  .trim()
  .min(1)
  .refine((provider) => getProviderDefinition(provider) !== undefined, {
    message: "Unknown LLM provider",
  });

export function getProviderDefinition(provider: string): LLMProviderCapability | undefined {
  return LLM_PROVIDER_CAPABILITIES.find(
    (definition) => definition.id === provider || definition.aliases.includes(provider),
  );
}

/**
 * Returns credentials only for an explicitly declared provider/host/Pi API tuple.
 * Callers must use this single lookup rather than composing host and auth checks.
 */
export function getProviderOutboundAuthPolicy(
  provider: string,
  hostname: string,
  api: ProviderApi,
): ProviderAuthPolicy | undefined {
  const definition = getProviderDefinition(provider);
  if (!definition?.hosts.includes(hostname)) return undefined;
  return definition.authPolicies.find((policy) => policy.api === api);
}
