import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderModelOptions,
  formatModelId,
  modelsDevProviderKey,
} from "../dist/provider-models.js";
import { agentRunnableModelIds } from "../dist/agent-models.js";

const catalog = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    models: {
      "kimi-k2.6": { id: "kimi-k2.6", name: "Kimi K2.6" },
      "glm-5.1": { id: "glm-5.1", name: "GLM 5.1" },
      "deepseek-v4-flash": { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    },
  },
};

test("modelsDevProviderKey only exposes supported providers", () => {
  assert.equal(modelsDevProviderKey("opencode-go"), "opencode-go");
  assert.equal(modelsDevProviderKey("openai"), undefined);
});

test("buildProviderModelOptions filters to live model ids and keeps display names", () => {
  const models = buildProviderModelOptions(
    "opencode-go",
    catalog,
    new Set(["kimi-k2.6", "glm-5.1", "deepseek-v4-flash"]),
    new Set(["kimi-k2.6", "glm-5.1"]),
  );

  assert.deepEqual(models, [
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
  ]);
});

test("buildProviderModelOptions falls back to formatted ids for live-only models", () => {
  const models = buildProviderModelOptions(
    "opencode-go",
    catalog,
    new Set(["kimi-k2.6", "mimo-v2.5"]),
  );

  assert.deepEqual(models, [
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "mimo-v2.5", name: "Mimo V2 5" },
  ]);
});

test("formatModelId title-cases hyphenated model ids", () => {
  assert.equal(formatModelId("gpt-5.4-mini"), "Gpt 5 4 Mini");
});

test("agentRunnableModelIds follows the maintained OpenCode Go catalog", () => {
  const runnable = agentRunnableModelIds("opencode-go");
  assert.equal(runnable?.has("kimi-k2.6"), true);
  assert.equal(runnable?.has("kimi-k2.7-code"), true);
  assert.equal(runnable?.has("deepseek-v4-flash"), true);
  assert.equal(runnable?.has("mimo-v2-omni"), false);
  assert.equal(runnable?.has("glm-5.2"), true);
});
