import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProviderCredentialSecrets,
  getProvisioningCredentialContext,
  requireProviderCredential,
  resolveProviderCredential,
} from "../dist/provider-credentials.js";

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
        "OpenAI Platform is not configured. Run `pnpm providers` on the Codevil host.",
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
