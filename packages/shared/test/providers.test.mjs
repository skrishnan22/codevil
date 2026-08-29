import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_APIS } from "../dist/index.js";
import * as shared from "../dist/index.js";

const INCLUDED_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "nvidia",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "openrouter",
  "together",
  "huggingface",
  "moonshotai",
  "moonshotai-cn",
  "zai",
  "zai-coding-cn",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "ant-ling",
  "kimi-coding",
  "vercel-ai-gateway",
  "fireworks",
  "opencode",
  "opencode-go",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
];

test("capability registry contains exactly the supported API-key Pi providers", () => {
  assert.deepEqual(
    shared.LLM_PROVIDER_CAPABILITIES.map((provider) => provider.id),
    INCLUDED_PROVIDER_IDS,
  );
});

test("KnownProviderSchema accepts included providers but rejects deferred provider ids", () => {
  assert.equal(shared.KnownProviderSchema.parse("opencode"), "opencode");
  assert.equal(shared.KnownProviderSchema.parse("opencode-go"), "opencode-go");

  for (const providerId of [
    "azure-openai-responses",
    "google-vertex",
    "amazon-bedrock",
    "openai-codex",
    "github-copilot",
    "anthropic-oauth",
    "custom",
  ]) {
    assert.equal(shared.KnownProviderSchema.safeParse(providerId).success, false, providerId);
  }
});

test("capability definitions have unique ids and distinct configuration requirements", () => {
  const ids = shared.LLM_PROVIDER_CAPABILITIES.map((provider) => provider.id);

  assert.equal(new Set(ids).size, ids.length);
  const providersWithConfig = shared.LLM_PROVIDER_CAPABILITIES.filter(
    (provider) => provider.configKeys.length > 0,
  );
  assert.deepEqual(
    providersWithConfig.map((provider) => [provider.id, provider.configKeys]),
    [
      ["cloudflare-workers-ai", ["CLOUDFLARE_ACCOUNT_ID"]],
      ["cloudflare-ai-gateway", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]],
    ],
  );
  for (const provider of shared.LLM_PROVIDER_CAPABILITIES) {
    assert.ok(provider.hosts.length > 0, `${provider.id} must have an outbound host allowlist`);
    assert.ok(provider.authPolicies.length > 0, `${provider.id} must have an auth policy`);
  }
});

test("Pi providers share their documented Worker secrets where credentials are interchangeable", () => {
  assert.equal(shared.getProviderDefinition("opencode")?.secretName, "OPENCODE_API_KEY");
  assert.equal(shared.getProviderDefinition("opencode-go")?.secretName, "OPENCODE_API_KEY");
  assert.equal(shared.getProviderDefinition("moonshotai")?.secretName, "MOONSHOT_API_KEY");
  assert.equal(shared.getProviderDefinition("moonshotai-cn")?.secretName, "MOONSHOT_API_KEY");
  assert.equal(
    shared.getProviderDefinition("cloudflare-workers-ai")?.secretName,
    "CLOUDFLARE_API_KEY",
  );
  assert.equal(
    shared.getProviderDefinition("cloudflare-ai-gateway")?.secretName,
    "CLOUDFLARE_API_KEY",
  );
});

test("OpenCode Go supports both Pi request protocols only at its declared host", () => {
  const provider = shared.getProviderDefinition("opencode-go");

  assert.deepEqual(provider?.aliases, []);
  assert.equal(provider?.id, "opencode-go");
  assert.deepEqual(provider?.hosts, ["opencode.ai"]);
  assert.deepEqual(
    provider?.authPolicies.map((policy) => policy.api),
    ["anthropic-messages", "openai-completions"],
  );
  assert.deepEqual(
    shared.getProviderOutboundAuthPolicy("opencode-go", "opencode.ai", "anthropic-messages"),
    { api: "anthropic-messages", header: "x-api-key", prefix: "" },
  );
  assert.deepEqual(
    shared.getProviderOutboundAuthPolicy("opencode-go", "opencode.ai", "openai-completions"),
    { api: "openai-completions", header: "authorization", prefix: "Bearer " },
  );
});

test("Fireworks has auth policies for every Pi protocol it serves", () => {
  assert.deepEqual(
    shared.getProviderDefinition("fireworks")?.authPolicies.map((policy) => policy.api),
    ["anthropic-messages", "openai-completions"],
  );
  assert.deepEqual(
    shared.getProviderOutboundAuthPolicy("fireworks", "api.fireworks.ai", "anthropic-messages"),
    { api: "anthropic-messages", header: "x-api-key", prefix: "" },
  );
  assert.deepEqual(
    shared.getProviderOutboundAuthPolicy("fireworks", "api.fireworks.ai", "openai-completions"),
    { api: "openai-completions", header: "authorization", prefix: "Bearer " },
  );
});

test("OpenCode Zen authenticates every supported Pi protocol with its complete policy", () => {
  const host = "opencode.ai";
  const expectedPolicies = [
    { api: "anthropic-messages", header: "x-api-key", prefix: "" },
    { api: "google-generative-ai", header: "x-goog-api-key", prefix: "" },
    { api: "openai-completions", header: "authorization", prefix: "Bearer " },
    { api: "openai-responses", header: "authorization", prefix: "Bearer " },
  ];

  assert.deepEqual(shared.getProviderDefinition("opencode")?.authPolicies, expectedPolicies);
  for (const policy of expectedPolicies) {
    assert.deepEqual(shared.getProviderOutboundAuthPolicy("opencode", host, policy.api), policy);
  }
});

test("Cloudflare AI Gateway authenticates every supported Pi protocol with its complete policy", () => {
  const host = "gateway.ai.cloudflare.com";
  const expectedPolicies = [
    { api: "anthropic-messages", header: "cf-aig-authorization", prefix: "Bearer " },
    { api: "openai-completions", header: "cf-aig-authorization", prefix: "Bearer " },
    { api: "openai-responses", header: "cf-aig-authorization", prefix: "Bearer " },
  ];

  assert.deepEqual(shared.getProviderDefinition("cloudflare-ai-gateway")?.authPolicies, expectedPolicies);
  for (const policy of expectedPolicies) {
    assert.deepEqual(
      shared.getProviderOutboundAuthPolicy("cloudflare-ai-gateway", host, policy.api),
      policy,
    );
  }
});

test("outbound provider policy fails closed for unknown providers, hosts, and APIs", () => {
  assert.equal(
    shared.getProviderOutboundAuthPolicy("not-a-provider", "api.openai.com", "openai-responses"),
    undefined,
  );
  assert.equal(
    shared.getProviderOutboundAuthPolicy("openai", "api.anthropic.com", "openai-responses"),
    undefined,
  );
  assert.equal(
    shared.getProviderOutboundAuthPolicy("openai", "api.openai.com", "anthropic-messages"),
    undefined,
  );
});

test("every declared provider host and Pi API has an outbound auth policy", () => {
  for (const provider of shared.LLM_PROVIDER_CAPABILITIES) {
    for (const hostname of provider.hosts) {
      for (const policy of provider.authPolicies) {
        assert.deepEqual(
          shared.getProviderOutboundAuthPolicy(provider.id, hostname, policy.api),
          policy,
          `${provider.id}/${hostname}/${policy.api}`,
        );
      }
    }
  }
});

test("every declared provider host fails closed for every unsupported Pi API", () => {
  for (const provider of shared.LLM_PROVIDER_CAPABILITIES) {
    const supportedApis = new Set(provider.authPolicies.map((policy) => policy.api));
    const unsupportedApis = PROVIDER_APIS.filter((api) => !supportedApis.has(api));

    for (const hostname of provider.hosts) {
      for (const api of unsupportedApis) {
        assert.equal(
          shared.getProviderOutboundAuthPolicy(provider.id, hostname, api),
          undefined,
          `${provider.id}/${hostname}/${api} must not receive credentials`,
        );
      }
    }
  }
});

test("Cloudflare providers declare the account and gateway configuration they need", () => {
  assert.deepEqual(
    shared.getProviderDefinition("cloudflare-workers-ai")?.configKeys,
    ["CLOUDFLARE_ACCOUNT_ID"],
  );
  assert.deepEqual(
    shared.getProviderDefinition("cloudflare-ai-gateway")?.configKeys,
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  );
  assert.equal(
    shared.getProviderOutboundAuthPolicy(
      "cloudflare-ai-gateway",
      "gateway.ai.cloudflare.com",
      "openai-responses",
    )?.header,
    "cf-aig-authorization",
  );
});

test("operator provider catalog is derived from every supported capability", () => {
  assert.deepEqual(
    shared.LLM_PROVIDERS.map((provider) => provider.id),
    INCLUDED_PROVIDER_IDS,
  );
});

test("only providers with an exact validation strategy are validated live", () => {
  assert.deepEqual(
    shared.LLM_PROVIDERS.filter((provider) => provider.validation).map((provider) => provider.id),
    ["openai", "openrouter", "opencode", "opencode-go"],
  );
  assert.equal(shared.LLM_PROVIDERS.find((provider) => provider.id === "anthropic")?.validation, undefined);
});

test("OpenCode Zen and OpenCode Go remain distinct Pi providers", () => {
  assert.equal(shared.getProviderDefinition("opencode")?.id, "opencode");
  assert.equal(shared.getProviderDefinition("opencode-go")?.id, "opencode-go");
});

test("unknown provider returns undefined", () => {
  assert.equal(shared.getProviderDefinition("not-a-provider"), undefined);
});
