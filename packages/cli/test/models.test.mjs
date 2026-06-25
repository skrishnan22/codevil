import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../dist/args.js";
import { checkAgentRunnableModel, listAgentRunnableModels } from "../dist/models.js";

test("parseCommand parses models list", () => {
  assert.deepEqual(parseCommand(["models", "list"]), {
    type: "models-list",
    provider: "opencode-go",
  });
  assert.deepEqual(parseCommand(["models", "list", "--provider", "opencode-go"]), {
    type: "models-list",
    provider: "opencode-go",
  });
});

test("parseCommand parses models check", () => {
  assert.deepEqual(parseCommand(["models", "check", "opencode-go/kimi-k2.6"]), {
    type: "models-check",
    provider: "opencode-go",
    modelId: "kimi-k2.6",
  });
});

test("listAgentRunnableModels includes kimi-k2.6 for opencode-go", () => {
  const models = listAgentRunnableModels("opencode-go");
  assert.equal(models.some((model) => model.id === "kimi-k2.6"), true);
});

test("checkAgentRunnableModel rejects unsupported opencode-go models", () => {
  assert.equal(checkAgentRunnableModel("opencode-go", "kimi-k2.6"), true);
  assert.equal(checkAgentRunnableModel("opencode-go", "deepseek-v4-flash"), true);
  assert.equal(checkAgentRunnableModel("opencode-go", "mimo-v2-omni"), false);
  assert.equal(checkAgentRunnableModel("opencode-go", "glm-5.2"), false);
});
