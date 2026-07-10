import assert from "node:assert/strict";
import test from "node:test";

import { LLM_PROVIDER_CAPABILITIES } from "@codevil/shared";

import {
  collectProviderCredentialSecrets,
  getProvisioningCredentialContext,
  requireProviderPublicConfig,
  requireProviderCredential,
  resolveProviderCredential,
} from "../dist/provider-credentials.js";
import { redactEvent } from "../dist/redaction.js";
import { collectWorkerSecretValues } from "../dist/worker-env.js";

test("collectWorkerSecretValues includes every deployment credential used by worker diagnostics", () => {
  const secrets = collectWorkerSecretValues({
    OPENAI_API_KEY: "provider-secret",
    CODEVIL_LLM_KEY: "legacy-secret",
    CODEVIL_API_KEY: "control-secret",
    GITHUB_PAT: "github-secret",
    R2_ACCESS_KEY_ID: "r2-access-secret",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    BETTER_AUTH_SECRET: "auth-secret",
    GOOGLE_CLIENT_SECRET: "google-secret",
    CODEVIL_SETUP_TOKEN: "setup-secret",
    RESEND_API_KEY: "resend-secret",
  });

  assert.deepEqual(secrets, [
    "provider-secret",
    "legacy-secret",
    "control-secret",
    "github-secret",
    "r2-access-secret",
    "r2-secret",
    "auth-secret",
    "google-secret",
    "setup-secret",
    "resend-secret",
  ]);
});

test("resolveProviderCredential uses dedicated credentials for canonical providers and alias", () => {
  const env = {
    OPENCODE_API_KEY: "opencode-key",
    OPENROUTER_API_KEY: "openrouter-key",
    OPENAI_API_KEY: "openai-key",
    CODEVIL_LLM_KEY: "legacy-key",
  };

  assert.equal(resolveProviderCredential(env, "opencode-go"), "opencode-key");
  assert.equal(resolveProviderCredential(env, "opencode"), "opencode-key");
  assert.equal(resolveProviderCredential(env, "openrouter"), "openrouter-key");
  assert.equal(resolveProviderCredential(env, "openai"), "openai-key");
});

test("resolveProviderCredential returns the normalized configured credential", () => {
  assert.equal(
    resolveProviderCredential({ OPENAI_API_KEY: "  padded-provider-key  " }, "openai"),
    "padded-provider-key",
  );
});

test("resolveProviderCredential uses every declared provider secret, including shared secrets", () => {
  assert.equal(
    resolveProviderCredential({ ANTHROPIC_API_KEY: "anthropic-key" }, "anthropic"),
    "anthropic-key",
  );
  assert.equal(
    resolveProviderCredential({ MOONSHOT_API_KEY: "moonshot-key" }, "moonshotai-cn"),
    "moonshot-key",
  );
  assert.equal(
    resolveProviderCredential({ CLOUDFLARE_API_KEY: "cloudflare-key" }, "cloudflare-ai-gateway"),
    "cloudflare-key",
  );
});

test("Cloudflare provider provisioning passes only declared public configuration", () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "account_123",
    CLOUDFLARE_GATEWAY_ID: "gateway_456",
    ARBITRARY_SANDBOX_ENV: "must-not-cross-boundary",
  };

  assert.deepEqual(
    requireProviderPublicConfig(env, "cloudflare-workers-ai"),
    { CLOUDFLARE_ACCOUNT_ID: "account_123" },
  );
  assert.deepEqual(
    requireProviderPublicConfig(env, "cloudflare-ai-gateway"),
    {
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      CLOUDFLARE_GATEWAY_ID: "gateway_456",
    },
  );
});

test("Cloudflare provider provisioning fails closed when required public configuration is blank or absent", () => {
  assert.throws(
    () => requireProviderPublicConfig({ CLOUDFLARE_ACCOUNT_ID: " " }, "cloudflare-workers-ai"),
    /Cloudflare Workers AI is missing required configuration: CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.throws(
    () => requireProviderPublicConfig(
      { CLOUDFLARE_ACCOUNT_ID: "account_123" },
      "cloudflare-ai-gateway",
    ),
    /Cloudflare AI Gateway is missing required configuration: CLOUDFLARE_GATEWAY_ID/,
  );
});

test("resolveProviderCredential falls back to legacy key when dedicated provider key is missing or blank", () => {
  const env = {
    OPENCODE_API_KEY: "",
    OPENROUTER_API_KEY: "   ",
    OPENAI_API_KEY: undefined,
    CODEVIL_LLM_KEY: "legacy-key",
  };

  assert.equal(resolveProviderCredential(env, "opencode-go"), "legacy-key");
  assert.equal(resolveProviderCredential(env, "openrouter"), "legacy-key");
  assert.equal(resolveProviderCredential(env, "openai"), "legacy-key");
});

test("resolveProviderCredential returns legacy key for unknown providers and undefined when none are configured", () => {
  assert.equal(resolveProviderCredential({ CODEVIL_LLM_KEY: "legacy-key" }, "mystery-provider"), "legacy-key");
  assert.equal(resolveProviderCredential({ CODEVIL_LLM_KEY: "   " }, "mystery-provider"), undefined);
  assert.equal(resolveProviderCredential({}, "mystery-provider"), undefined);
});

test("requireProviderCredential returns the resolved key", () => {
  assert.equal(
    requireProviderCredential(
      {
        OPENAI_API_KEY: "openai-key",
        CODEVIL_LLM_KEY: "legacy-key",
      },
      "openai",
    ),
    "openai-key",
  );
});

test("requireProviderCredential throws an actionable error without env secret names", () => {
  assert.throws(
    () => requireProviderCredential({}, "openrouter"),
    (error) => {
      assert.equal(
        error.message,
        "OpenRouter is not configured. Run `pnpm providers` on the Codevil host.",
      );
      assert.equal(error.message.includes("OPENROUTER_API_KEY"), false);
      return true;
    },
  );

  assert.throws(
    () => requireProviderCredential({}, "mystery-provider"),
    (error) => {
      assert.equal(
        error.message,
        "mystery-provider is not configured. Run `pnpm providers` on the Codevil host.",
      );
      return true;
    },
  );
});

test("getProvisioningCredentialContext returns the exact dedicated provider credential context", () => {
  assert.deepEqual(
    getProvisioningCredentialContext(
      {
        OPENROUTER_API_KEY: "openrouter-key",
        CODEVIL_LLM_KEY: "legacy-key",
      },
      "openrouter",
    ),
    {
      llmKey: "openrouter-key",
      hasLlmKey: true,
    },
  );
});

test("getProvisioningCredentialContext falls back to the exact legacy credential context", () => {
  assert.deepEqual(
    getProvisioningCredentialContext(
      {
        OPENAI_API_KEY: "   ",
        CODEVIL_LLM_KEY: "legacy-key",
      },
      "openai",
    ),
    {
      llmKey: "legacy-key",
      hasLlmKey: true,
    },
  );
});

test("getProvisioningCredentialContext throws before any provisioning context exists when provider is missing", () => {
  assert.throws(
    () => getProvisioningCredentialContext({}, "openai"),
    (error) => {
      assert.equal(
        error.message,
        "OpenAI is not configured. Run `pnpm providers` on the Codevil host.",
      );
      return true;
    },
  );
});

test("collectProviderCredentialSecrets includes dedicated and legacy values with blanks removed and duplicates deduplicated", () => {
  assert.deepEqual(
    collectProviderCredentialSecrets({
      OPENCODE_API_KEY: "shared-key",
      OPENROUTER_API_KEY: "router-key",
      OPENAI_API_KEY: "shared-key",
      CODEVIL_LLM_KEY: "legacy-key",
    }),
    ["shared-key", "router-key", "legacy-key"],
  );

  assert.deepEqual(
    collectProviderCredentialSecrets({
      OPENCODE_API_KEY: "",
      OPENROUTER_API_KEY: "   ",
      OPENAI_API_KEY: undefined,
      CODEVIL_LLM_KEY: "legacy-key",
    }),
    ["legacy-key"],
  );
});

test("collectProviderCredentialSecrets includes every capability secret so configured credentials are redacted", () => {
  const secretNames = [...new Set(LLM_PROVIDER_CAPABILITIES.map((provider) => provider.secretName))];
  const env = Object.fromEntries(
    secretNames.map((secretName) => [secretName, `credential-for-${secretName}`]),
  );

  const secrets = secretNames.map((secretName) => `credential-for-${secretName}`);
  assert.deepEqual(collectProviderCredentialSecrets(env), secrets);
  assert.equal(
    redactEvent({ error: secrets.join(",") }, secrets).error,
    secrets.map(() => "[REDACTED]").join(","),
  );
});
