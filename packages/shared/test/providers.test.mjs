import assert from "node:assert/strict";
import test from "node:test";

import * as shared from "../dist/index.js";

test("provider catalog preserves canonical order", () => {
  assert.deepEqual(
    shared.LLM_PROVIDERS.map((provider) => provider.id),
    ["opencode-go", "openrouter", "openai"],
  );
});

test("provider catalog matches the exact expected entries", () => {
  assert.deepEqual(shared.LLM_PROVIDERS, [
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
  ]);
});

test("opencode alias resolves to opencode-go", () => {
  assert.equal(shared.getProviderDefinition("opencode")?.id, "opencode-go");
});

test("unknown provider returns undefined", () => {
  assert.equal(shared.getProviderDefinition("not-a-provider"), undefined);
});

test("secret names are unique across providers", () => {
  const secretNames = shared.LLM_PROVIDERS.map((provider) => provider.secretName);
  assert.equal(new Set(secretNames).size, secretNames.length);
});
