import { describe, it, expect, vi } from "vitest";
import {
  acceptInvite,
  claimSetup,
  createInvitation,
  createSession,
  getAuthMe,
  getInvite,
  getSession,
  listInvitations,
  listSessions,
  revokeInvitation,
  signInWithGoogle,
  signOut,
} from "../api-client";

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
      { endpoint: "https://example.com" },
      { repo: "github.com/user/repo" },
      mockFetch,
    );

    expect(result.session_id).toBe("ses_123");
    expect(result.ws_url).toBe("wss://example.com/sessions/ses_123/ws");
    expect(result.summary.title).toBe("user/repo");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ repo: "github.com/user/repo" });
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/sessions", expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    }));
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
      { endpoint: "https://example.com" },
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
        { endpoint: "https://example.com" },
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
      { endpoint: "https://example.com/" },
      mockFetch,
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("ses_123");
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/sessions", {
      method: "GET",
      credentials: "include",
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
      { endpoint: "https://example.com" },
      "ses_123",
      mockFetch,
    );

    expect(result.session.id).toBe("ses_123");
    expect(result.ws_url).toBe("https://example.com/sessions/ses_123/ws");
  });
});

describe("getAuthMe", () => {
  it("fetches auth state with browser credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        authenticated: false,
        setupRequired: true,
        authConfigured: true,
      }),
    });

    const result = await getAuthMe({ endpoint: "https://example.com" }, mockFetch);

    expect(result.setupRequired).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/auth/me", {
      method: "GET",
      credentials: "include",
    });
  });
});

describe("claimSetup", () => {
  it("posts setup token with browser credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        authenticated: true,
        setupRequired: false,
        authConfigured: true,
        user: { id: "usr_123", email: "alice@example.com", name: "Alice" },
        membership: { role: "owner", status: "active" },
      }),
    });

    const result = await claimSetup(
      { endpoint: "https://example.com/" },
      "setup-token",
      mockFetch,
    );

    expect(result.membership?.role).toBe("owner");
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/setup/claim", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupToken: "setup-token" }),
    });
  });
});

describe("signInWithGoogle", () => {
  it("builds a top-level Worker sign-in URL without cross-origin fetch", async () => {
    const mockFetch = vi.fn();

    const result = await signInWithGoogle(
      { endpoint: "https://example.com" },
      "https://app.example.com/setup",
      mockFetch,
    );

    expect(result).toEqual({
      redirect: true,
      url: "https://example.com/api/auth/sign-in/google?callbackURL=https%3A%2F%2Fapp.example.com%2Fsetup&errorCallbackURL=https%3A%2F%2Fapp.example.com%2Fsetup",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("posts Better Auth sign-out with browser credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await signOut({ endpoint: "https://example.com/" }, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it("throws when sign-out fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(signOut({ endpoint: "https://example.com" }, mockFetch)).rejects.toThrow("500");
  });
});

describe("listInvitations", () => {
  it("fetches pending invitations with browser credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        invitations: [
          {
            id: "inv_123",
            email: "alice@example.com",
            role: "developer",
            status: "pending",
            expires_at: "2026-06-25T00:00:00.000Z",
            created_at: "2026-06-11T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await listInvitations({ endpoint: "https://example.com/" }, mockFetch);

    expect(result.invitations).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/invitations", {
      method: "GET",
      credentials: "include",
    });
  });
});

describe("createInvitation", () => {
  it("creates an invite and returns its one-time link", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({
        status: "created",
        invitation: {
          id: "inv_123",
          email: "alice@example.com",
          role: "developer",
          status: "pending",
          expires_at: "2026-06-25T00:00:00.000Z",
          created_at: "2026-06-11T00:00:00.000Z",
        },
        invite_url: "https://app.example.com/invite/inv_token",
        email_delivery: { provider: "resend", status: "sent", messageId: "email_123" },
      }),
    });

    const result = await createInvitation(
      { endpoint: "https://example.com" },
      { email: "Alice@Example.COM", role: "developer" },
      mockFetch,
    );

    expect(result.status).toBe("created");
    expect(result.invite_url).toBe("https://app.example.com/invite/inv_token");
    expect(result.email_delivery).toEqual({ provider: "resend", status: "sent", messageId: "email_123" });
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/invitations", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Alice@Example.COM", role: "developer" }),
    });
  });

  it("returns duplicate/member statuses without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ status: "already_invited" }),
    });

    const result = await createInvitation(
      { endpoint: "https://example.com" },
      { email: "alice@example.com", role: "viewer" },
      mockFetch,
    );

    expect(result.status).toBe("already_invited");
  });
});

describe("getInvite", () => {
  it("reads invite state without credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: "pending",
        invitation: {
          email: "alice@example.com",
          role: "developer",
          expires_at: "2026-06-25T00:00:00.000Z",
        },
      }),
    });

    const result = await getInvite({ endpoint: "https://example.com" }, "inv_token", mockFetch);

    expect(result.status).toBe("pending");
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/invite/inv_token", {
      method: "GET",
    });
  });
});

describe("acceptInvite", () => {
  it("accepts an invite with browser credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: "accepted",
        membership: { role: "developer", status: "active" },
      }),
    });

    const result = await acceptInvite({ endpoint: "https://example.com" }, "inv_token", mockFetch);

    expect(result.status).toBe("accepted");
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/invite/inv_token/accept", {
      method: "POST",
      credentials: "include",
    });
  });
});

describe("revokeInvitation", () => {
  it("revokes a pending invite with browser credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "revoked" }),
    });

    const result = await revokeInvitation({ endpoint: "https://example.com" }, "inv_123", mockFetch);

    expect(result.status).toBe("revoked");
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/invitations/inv_123/revoke", {
      method: "POST",
      credentials: "include",
    });
  });
});
