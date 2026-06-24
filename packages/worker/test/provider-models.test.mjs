import assert from "node:assert/strict";
import test from "node:test";

import { listProviderModelOptions } from "../dist/provider-models.js";

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

test("listProviderModelOptions intersects models.dev with OpenCode Go live models", async () => {
  const fetcher = async (url) => {
    if (url === "https://models.dev/api.json") {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    if (url === "https://opencode.ai/zen/go/v1/models") {
      return new Response(JSON.stringify({
        data: [{ id: "kimi-k2.6" }, { id: "glm-5.1" }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const models = await listProviderModelOptions("opencode-go", fetcher);
  assert.deepEqual(models, [
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
  ]);
});

test("listProviderModelOptions rejects unknown providers", async () => {
  await assert.rejects(
    () => listProviderModelOptions("anthropic", async () => new Response("{}", { status: 200 })),
    /Unknown provider/,
  );
});
