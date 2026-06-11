import type {
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
} from "@codevil/shared";
import type { SessionConfig, NewSessionParams } from "../types";

type FetchFn = typeof globalThis.fetch;

export interface AuthMeResponse {
  authenticated: boolean;
  setupRequired: boolean;
  authConfigured: boolean;
  user?: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
  membership?: {
    role: "owner" | "admin" | "developer" | "viewer";
    status: "active" | "disabled";
  };
}

export interface SignInWithGoogleResponse {
  redirect: boolean;
  url: string;
}

export type InvitationRole = "owner" | "admin" | "developer" | "viewer";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationSummary {
  id: string;
  email: string;
  role: InvitationRole;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
}

export interface ListInvitationsResponse {
  invitations: InvitationSummary[];
}

export interface CreateInvitationResponse {
  status: "created" | "already_invited" | "already_member" | "member_disabled";
  invitation?: InvitationSummary;
  invite_url?: string;
  email_delivery?:
    | { provider: "none"; status: "not_configured" }
    | { provider: "resend"; status: "sent"; messageId: string }
    | { provider: "resend"; status: "failed"; error: string };
}

export interface GetInviteResponse {
  status: InvitationStatus | "invalid";
  invitation?: {
    email: string;
    role: InvitationRole;
    expires_at: string;
  };
}

export interface AcceptInviteResponse {
  status: "accepted";
  membership: {
    role: InvitationRole;
    status: "active";
  };
}

export interface RevokeInvitationResponse {
  status: "revoked";
}

export async function createSession(
  config: SessionConfig,
  params: NewSessionParams,
  fetcher: FetchFn = globalThis.fetch,
): Promise<CreateSessionResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");

  const response = await fetcher(`${endpoint}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      repo: params.repo,
      provider: params.provider,
      plan_model: params.planModel,
      exec_model: params.execModel,
      max_cost: params.maxCost,
      max_session_time: params.maxSessionTime,
      max_idle_time: params.maxIdleTime,
      max_steps: params.maxSteps,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as Record<string, unknown>;
      detail = String(body.detail ?? body.error ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to create session: ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  const body = (await response.json()) as CreateSessionResponse;
  return { session_id: body.session_id, ws_url: body.ws_url, summary: body.summary };
}

export async function listSessions(
  config: SessionConfig,
  fetcher: FetchFn = globalThis.fetch,
): Promise<ListSessionsResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/sessions`, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to list sessions: ${response.status}`);
  }

  return (await response.json()) as ListSessionsResponse;
}

export async function getSession(
  config: SessionConfig,
  sessionId: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<GetSessionResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/sessions/${sessionId}`, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.status}`);
  }

  return (await response.json()) as GetSessionResponse;
}

export async function getAuthMe(
  config: Pick<SessionConfig, "endpoint">,
  fetcher: FetchFn = globalThis.fetch,
): Promise<AuthMeResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/auth/me`, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to get auth state: ${response.status}`);
  }

  return (await response.json()) as AuthMeResponse;
}

export async function claimSetup(
  config: Pick<SessionConfig, "endpoint">,
  setupToken: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<AuthMeResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/setup/claim`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupToken }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as Record<string, unknown>;
      detail = String(body.detail ?? body.error ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to claim setup: ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  return (await response.json()) as AuthMeResponse;
}

export async function signInWithGoogle(
  config: Pick<SessionConfig, "endpoint">,
  callbackURL: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<SignInWithGoogleResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/api/auth/sign-in/social`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "google",
      callbackURL,
      errorCallbackURL: callbackURL,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start Google sign-in: ${response.status}`);
  }

  return (await response.json()) as SignInWithGoogleResponse;
}

export async function signOut(
  config: Pick<SessionConfig, "endpoint">,
  fetcher: FetchFn = globalThis.fetch,
): Promise<void> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to sign out: ${response.status}`);
  }
}

export async function listInvitations(
  config: Pick<SessionConfig, "endpoint">,
  fetcher: FetchFn = globalThis.fetch,
): Promise<ListInvitationsResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/invitations`, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to list invitations: ${response.status}`);
  }

  return (await response.json()) as ListInvitationsResponse;
}

export async function createInvitation(
  config: Pick<SessionConfig, "endpoint">,
  invitation: { email: string; role: InvitationRole },
  fetcher: FetchFn = globalThis.fetch,
): Promise<CreateInvitationResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/invitations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(invitation),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as Record<string, unknown>;
      detail = String(body.detail ?? body.error ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to create invitation: ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  return (await response.json()) as CreateInvitationResponse;
}

export async function getInvite(
  config: Pick<SessionConfig, "endpoint">,
  token: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<GetInviteResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/invite/${encodeURIComponent(token)}`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Failed to get invite: ${response.status}`);
  }

  return (await response.json()) as GetInviteResponse;
}

export async function acceptInvite(
  config: Pick<SessionConfig, "endpoint">,
  token: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<AcceptInviteResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/invite/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as Record<string, unknown>;
      detail = String(body.detail ?? body.error ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to accept invite: ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  return (await response.json()) as AcceptInviteResponse;
}

export async function revokeInvitation(
  config: Pick<SessionConfig, "endpoint">,
  invitationId: string,
  fetcher: FetchFn = globalThis.fetch,
): Promise<RevokeInvitationResponse> {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetcher(`${endpoint}/invitations/${encodeURIComponent(invitationId)}/revoke`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to revoke invitation: ${response.status}`);
  }

  return (await response.json()) as RevokeInvitationResponse;
}
