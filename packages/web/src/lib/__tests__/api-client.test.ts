import { describe, it, expect, vi } from "vitest";
import { createSession, getSession, listSessions } from "../api-client";

describe("createSession", () => {
  it("sends repo-only POST /sessions and returns room summary", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        session_id: "ses_123",
        ws_url: "wss://example.com/sessions/ses_123/ws",
        summary: {
          id: "ses_123",
          title: "user/repo",
          repo: "github.com/user/repo",
          room_state: "initializing",
          sandbox_state: "not_started",
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T00:00:00.000Z",
          last_event_at: "2026-06-03T00:00:00.000Z",
        },
      }),
    });

    const result = await createSession(
      { endpoint: "https://example.com", apiKey: "cdv_test" },
      { repo: "github.com/user/repo" },
      mockFetch,
    );

    expect(result.session_id).toBe("ses_123");
    expect(result.ws_url).toBe("wss://example.com/sessions/ses_123/ws");
    expect(result.summary.title).toBe("user/repo");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ repo: "github.com/user/repo" });
  });

  it("sends selected provider and models when creating a session", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        session_id: "ses_123",
        ws_url: "wss://example.com/sessions/ses_123/ws",
        summary: {
          id: "ses_123",
          title: "user/repo",
          repo: "github.com/user/repo",
          room_state: "initializing",
          sandbox_state: "not_started",
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T00:00:00.000Z",
          last_event_at: "2026-06-03T00:00:00.000Z",
        },
      }),
    });

    await createSession(
      { endpoint: "https://example.com", apiKey: "cdv_test" },
      {
        repo: "github.com/user/repo",
        provider: "openai",
        planModel: "gpt-5.4",
        execModel: "gpt-5.4-mini",
        maxIdleTime: "10m",
        maxSessionTime: "30m",
      },
      mockFetch,
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("openai");
    expect(body.plan_model).toBe("gpt-5.4");
    expect(body.exec_model).toBe("gpt-5.4-mini");
    expect(body.max_idle_time).toBe("10m");
    expect(body.max_session_time).toBe("30m");
    expect(body.prompt).toBeUndefined();
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
        { repo: "github.com/u/r" },
        mockFetch,
      ),
    ).rejects.toThrow("401");
  });
});

describe("listSessions", () => {
  it("fetches cloud-backed session summaries", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        sessions: [
          {
            id: "ses_123",
            title: "user/repo",
            repo: "github.com/user/repo",
            room_state: "ready",
            sandbox_state: "ready",
            created_at: "2026-06-03T00:00:00.000Z",
            updated_at: "2026-06-03T00:00:00.000Z",
            last_event_at: "2026-06-03T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await listSessions(
      { endpoint: "https://example.com/", apiKey: "cdv_test" },
      mockFetch,
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("ses_123");
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/sessions", {
      method: "GET",
      headers: { Authorization: "Bearer cdv_test" },
    });
  });
});

describe("getSession", () => {
  it("fetches one session summary and websocket url", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        session: {
          id: "ses_123",
          title: "user/repo",
          repo: "github.com/user/repo",
          room_state: "ready",
          sandbox_state: "ready",
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T00:00:00.000Z",
          last_event_at: "2026-06-03T00:00:00.000Z",
        },
        ws_url: "https://example.com/sessions/ses_123/ws",
      }),
    });

    const result = await getSession(
      { endpoint: "https://example.com", apiKey: "cdv_test" },
      "ses_123",
      mockFetch,
    );

    expect(result.session.id).toBe("ses_123");
    expect(result.ws_url).toBe("https://example.com/sessions/ses_123/ws");
  });
});
