import { describe, it, expect, vi } from "vitest";
import { createSession } from "../api-client";

describe("createSession", () => {
  it("sends POST /sessions and returns session_id + ws_url", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        session_id: "ses_123",
        ws_url: "wss://example.com/sessions/ses_123/ws",
      }),
    });

    const result = await createSession(
      { endpoint: "https://example.com", apiKey: "cdv_test" },
      { prompt: "add tests", repo: "github.com/user/repo" },
      mockFetch,
    );

    expect(result.session_id).toBe("ses_123");
    expect(result.ws_url).toBe("wss://example.com/sessions/ses_123/ws");

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer cdv_test",
        "Content-Type": "application/json",
      },
      body: expect.stringContaining('"prompt":"add tests"'),
    });
  });

  it("sends selected provider and models when creating a session", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        session_id: "ses_123",
        ws_url: "wss://example.com/sessions/ses_123/ws",
      }),
    });

    await createSession(
      { endpoint: "https://example.com", apiKey: "cdv_test" },
      {
        prompt: "add tests",
        repo: "github.com/user/repo",
        provider: "openai",
        planModel: "gpt-5.4",
        execModel: "gpt-5.4-mini",
      },
      mockFetch,
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("openai");
    expect(body.plan_model).toBe("gpt-5.4");
    expect(body.exec_model).toBe("gpt-5.4-mini");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
    });

    await expect(
      createSession(
        { endpoint: "https://example.com", apiKey: "bad" },
        { prompt: "test", repo: "github.com/u/r" },
        mockFetch,
      ),
    ).rejects.toThrow("401");
  });
});
