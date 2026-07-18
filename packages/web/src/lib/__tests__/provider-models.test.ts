import { describe, expect, it, vi } from "vitest";
import { agentRunnableModelIds } from "@codevil/shared";
import { listProviderModels } from "../provider-models";

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

describe("listProviderModels", () => {
  it("loads display names from models.dev and filters to live OpenCode Go models", async () => {
    const fetcher = vi.fn(async (url: RequestInfo) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "https://models.dev/api.json") {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      if (href === "https://opencode.ai/zen/go/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "kimi-k2.6" },
            { id: "glm-5.1" },
            { id: "deepseek-v4-flash" },
          ],
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });

    await expect(listProviderModels("opencode-go", fetcher as typeof fetch)).resolves.toEqual([
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "glm-5.1", name: "GLM 5.1" },
      { id: "kimi-k2.6", name: "Kimi K2.6" },
    ]);

    const runnable = agentRunnableModelIds("opencode-go");
    expect(runnable?.has("deepseek-v4-flash")).toBe(true);
    expect(runnable?.has("mimo-v2-omni")).toBe(false);
  });

  it("rejects unknown providers", async () => {
    await expect(
      listProviderModels("not-a-provider", async () => new Response("{}", { status: 200 })),
    ).rejects.toThrow(/Unknown provider/);
  });

  it("returns no catalog options without fetching for providers that require a typed model id", async () => {
    const fetcher = vi.fn();

    await expect(listProviderModels("anthropic", fetcher as typeof fetch)).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
