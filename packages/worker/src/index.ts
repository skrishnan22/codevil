import { Orchestrator } from "./orchestrator.js";
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import {
  getCodevilSandbox,
  recordSandboxLifecycleEvent,
  SANDBOX_KEEPALIVE_STATE_KEY,
  SANDBOX_LIFECYCLE_EVENT_KEY,
  shouldDeferSandboxActivityExpiry,
  type SandboxKeepAliveState,
  type SandboxLifecycleEvent,
} from "./sandbox.js";
import {
  buildSessionSummary,
  normalizeCreateSessionBody,
  recentSessionsSelect,
  sessionByIdSelect,
  sessionDirectoryFailureUpdate,
  sessionDirectoryInsert,
  type SessionDirectoryRow,
} from "./session-directory.js";
import { createCodevilAuth } from "./auth.js";
import {
  activeMembershipByUserSelect,
  createOwnerMembershipInsert,
  normalizeEmail,
  ownerExistsSelect,
  pendingInviteByEmailSelect,
  type InvitationRow,
  type MembershipRow,
} from "./memberships.js";
import {
  acceptInvitationUpdate,
  canInviteRole,
  createInvitationInsert,
  createInviteToken,
  createMembershipFromInviteInsert,
  hashInviteToken,
  invitationByIdSelect,
  invitationByTokenHashSelect,
  inviteExpiresAt,
  inviteStatus,
  listPendingInvitationsSelect,
  membershipByEmailSelect,
  membershipByUserSelect,
  parseInviteRole,
  revokeInvitationUpdate,
  type InvitationStatus,
} from "./invitations.js";
import { buildAuthMeResponse, verifySetupToken, type AuthSession } from "./auth-service.js";
import {
  buildGoogleSocialSignInRequest,
  GOOGLE_SOCIAL_SIGN_IN_PATH,
  googleSocialSignInRedirectResponse,
} from "./auth-redirect.js";
import { configuredWebOrigins, missingAuthConfigKeys } from "./auth-config.js";
import { createEmailProvider } from "./email.js";
import { isOriginGuardedPath, requireTrustedOrigin } from "./http-guards.js";
import { can, type AuthAction } from "@codevil/shared";

// Subclass the Cloudflare Sandbox so Codevil can keep active agent sessions
// alive and persist stop diagnostics across abnormal socket closures.
export class Sandbox<Env = unknown> extends BaseSandbox<Env> {
  override sleepAfter = "10m";

  async setCodevilKeepAlive(active: boolean, reason = "unspecified"): Promise<void> {
    const state: SandboxKeepAliveState = {
      active,
      reason,
      updated_at: new Date().toISOString(),
    };
    await this.ctx.storage.put(SANDBOX_KEEPALIVE_STATE_KEY, state);
    if (active) this.renewActivityTimeout();
    console.log("codevil.sandbox.keepalive", state);
  }

  async getCodevilLifecycleSnapshot(): Promise<{
    keepAlive?: SandboxKeepAliveState;
    lastEvent?: SandboxLifecycleEvent;
  }> {
    const [keepAlive, lastEvent] = await Promise.all([
      this.ctx.storage.get<SandboxKeepAliveState>(SANDBOX_KEEPALIVE_STATE_KEY),
      this.ctx.storage.get<SandboxLifecycleEvent>(SANDBOX_LIFECYCLE_EVENT_KEY),
    ]);
    return {
      ...(keepAlive ? { keepAlive } : {}),
      ...(lastEvent ? { lastEvent } : {}),
    };
  }

  override async onStart(): Promise<void> {
    await this.recordLifecycle({ type: "start", at: new Date().toISOString() });
    await Promise.resolve(super.onStart());
  }

  override async onStop(params?: unknown): Promise<void> {
    await this.recordLifecycle({
      type: "stop",
      at: new Date().toISOString(),
      ...stopDiagnostics(params),
    });
    await Promise.resolve(super.onStop());
  }

  override async onError(error: unknown): Promise<void> {
    await this.recordLifecycle({
      type: "error",
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    await Promise.resolve(super.onError(error));
  }

  override async onActivityExpired(): Promise<void> {
    const keepAlive = await this.ctx.storage.get<SandboxKeepAliveState>(SANDBOX_KEEPALIVE_STATE_KEY);
    if (keepAlive && shouldDeferSandboxActivityExpiry(keepAlive)) {
      await this.recordLifecycle({
        type: "activity_expired_deferred",
        at: new Date().toISOString(),
        reason: keepAlive.reason,
      });
      this.renewActivityTimeout();
      console.log("codevil.sandbox.activity_expired_deferred", keepAlive);
      return;
    }

    await this.recordLifecycle({
      type: "activity_expired",
      at: new Date().toISOString(),
    });
    await super.onActivityExpired();
  }

  private async recordLifecycle(event: SandboxLifecycleEvent): Promise<void> {
    console.log("codevil.sandbox.lifecycle", event);
    await recordSandboxLifecycleEvent(this.ctx.storage, event);
  }

  override async fetch(request: Request): Promise<Response> {
    // The base Sandbox.fetch() routes by URL path/port and ignores the
    // cf-container-target-port header that switchPort() sets. We need the
    // header path so callers can use sandbox.fetch(switchPort(req, port)) —
    // the only way to proxy WebSocket upgrades across the DO boundary, since
    // containerFetch() is JSRPC and cannot transport a WebSocket pair.
    const header = request.headers.get("cf-container-target-port");
    if (header) {
      const port = Number.parseInt(header, 10);
      if (Number.isFinite(port)) {
        return this.containerFetch(request, port);
      }
    }
    return super.fetch(request);
  }
}

function stopDiagnostics(params: unknown): Pick<SandboxLifecycleEvent, "exit_code" | "reason"> {
  if (!params || typeof params !== "object") return {};

  const record = params as Record<string, unknown>;
  const exitCode = record.exitCode;
  const reason = record.reason;

  return {
    ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  CODEVIL_API_KEY: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CODEVIL_SETUP_TOKEN?: string;
  CODEVIL_WEB_ORIGIN?: string;
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  CODEVIL_APP_NAME?: string;
}

export { Orchestrator };

const CORS_BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Upgrade",
  "Vary": "Origin",
};

function corsHeadersFor(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin")?.replace(/\/$/, "");
  if (!origin) {
    return {
      ...CORS_BASE_HEADERS,
      "Access-Control-Allow-Origin": "*",
    };
  }

  if (configuredWebOrigins(env).includes(origin)) {
    return {
      ...CORS_BASE_HEADERS,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    };
  }

  return {
    ...CORS_BASE_HEADERS,
    "Access-Control-Allow-Origin": "*",
  };
}

function withCors(request: Request, env: Env, response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeadersFor(request, env))) {
    patched.headers.set(k, v);
  }
  return patched;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (isOriginGuardedPath(request.method, path)) {
      const originGuard = requireTrustedOrigin(request, env);
      if (originGuard) return withCors(request, env, originGuard);
    }

    if (path === GOOGLE_SOCIAL_SIGN_IN_PATH && request.method === "GET") {
      return handleGoogleSocialSignInRedirect(request, env);
    }

    if (path.startsWith("/api/auth/")) {
      return withCors(request, env, await handleBetterAuth(request, env));
    }

    const hostPreview = previewTokenFromHost(url.hostname);
    if (hostPreview) {
      return handleSessionPreview(request, env, hostPreview.sessionId, hostPreview.token);
    }

    const previewMatch = path.match(/^\/sessions\/([^/]+)\/preview\/([^/]+)(?:\/.*)?$/);
    if (previewMatch) {
      return handleSessionPreview(request, env, previewMatch[1], previewMatch[2]);
    }

    if (path === "/auth/me" && request.method === "GET") {
      return withCors(request, env, await handleAuthMe(request, env));
    }

    if (path === "/setup/claim" && request.method === "POST") {
      return withCors(request, env, await handleSetupClaim(request, env));
    }

    if (path === "/invitations" && request.method === "GET") {
      const auth = await requireAuthContext(request, env, "members:invite");
      if (auth instanceof Response) return withCors(request, env, auth);
      return withCors(request, env, await handleListInvitations(env));
    }

    if (path === "/invitations" && request.method === "POST") {
      const auth = await requireAuthContext(request, env, "members:invite");
      if (auth instanceof Response) return withCors(request, env, auth);
      return withCors(request, env, await handleCreateInvitation(request, env, auth));
    }

    const revokeInvitationMatch = path.match(/^\/invitations\/([^/]+)\/revoke$/);
    if (revokeInvitationMatch && request.method === "POST") {
      const auth = await requireAuthContext(request, env, "members:invite");
      if (auth instanceof Response) return withCors(request, env, auth);
      return withCors(request, env, await handleRevokeInvitation(env, revokeInvitationMatch[1]));
    }

    const inviteAcceptMatch = path.match(/^\/invite\/([^/]+)\/accept$/);
    if (inviteAcceptMatch && request.method === "POST") {
      return withCors(request, env, await handleAcceptInvite(request, env, inviteAcceptMatch[1]));
    }

    const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
    if (inviteMatch && request.method === "GET") {
      return withCors(request, env, await handleGetInvite(env, inviteMatch[1]));
    }

    // POST /sessions — create a new session
    if (path === "/sessions" && request.method === "POST") {
      const auth = await requireAuthContext(request, env, "sessions:create");
      if (auth instanceof Response) return withCors(request, env, auth);
      return withCors(request, env, await handleCreateSession(request, env, auth));
    }

    if (path === "/sessions" && request.method === "GET") {
      const auth = await requireAuthContext(request, env, "sessions:read");
      if (auth instanceof Response) return withCors(request, env, auth);
      return withCors(request, env, await handleListSessions(request, env));
    }

    const sessionInfoMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionInfoMatch && request.method === "GET") {
      const auth = await requireAuthContext(request, env, "sessions:read");
      if (auth instanceof Response) return withCors(request, env, auth);
      return withCors(request, env, await handleGetSession(request, env, sessionInfoMatch[1]));
    }

    // GET /sessions/:id/ws — WebSocket upgrade
    const wsMatch = path.match(/^\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && request.method === "GET") {
      const auth = await requireAuthContext(request, env, "sessions:read");
      if (auth instanceof Response) return auth;
      return handleWebSocketUpgrade(request, env, wsMatch[1], auth);
    }

    const sandboxWsMatch = path.match(/^\/sessions\/([^/]+)\/sandbox\/ws$/);
    if (sandboxWsMatch && request.method === "GET") {
      if (!authenticate(request, env.CODEVIL_API_KEY)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return handleSandboxWebSocketUpgrade(request, env, sandboxWsMatch[1]);
    }

    // GET /sessions/:id/logs — read sandbox process logs (dev only)
    const logsMatch = path.match(/^\/sessions\/([^/]+)\/logs$/);
    if (logsMatch && request.method === "GET") {
      if (!authenticate(request, env.CODEVIL_API_KEY)) {
        return withCors(request, env, json({ error: "Unauthorized" }, 401));
      }
      return withCors(request, env, await handleLogs(env, logsMatch[1]));
    }

    // POST /sessions/:id/simulate — trigger test events (dev only)
    const simMatch = path.match(/^\/sessions\/([^/]+)\/simulate$/);
    if (simMatch && request.method === "POST") {
      if (!authenticate(request, env.CODEVIL_API_KEY)) {
        return withCors(request, env, json({ error: "Unauthorized" }, 401));
      }
      return withCors(request, env, await handleSimulate(env, simMatch[1]));
    }

    return withCors(request, env, json({ error: "Not found" }, 404));
  },
} satisfies ExportedHandler<Env>;

function authenticate(request: Request, apiKey: string): boolean {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const [scheme, token] = auth.split(" ", 2);
    if (scheme === "Bearer" && token === apiKey) return true;
  }

  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam === apiKey) return true;

  return false;
}

interface AuthContext {
  userId: string;
  email: string;
  name: string;
  image?: string;
  role: MembershipRow["role"];
}

function previewTokenFromHost(hostname: string): { sessionId: string; token: string } | null {
  const label = hostname.split(".", 1)[0];
  const match = label.match(/^(ses-[a-f0-9]{32})-[a-f0-9]{24}$/);
  if (!match) return null;
  return {
    sessionId: match[1].replace(/^ses-/, "ses_"),
    token: label,
  };
}

async function handleBetterAuth(request: Request, env: Env): Promise<Response> {
  const missing = missingAuthConfigKeys(env);
  if (missing.length > 0) {
    return json({
      error: "Auth is not configured",
      missing,
    }, 503);
  }

  const auth = createCodevilAuth(env);
  return auth.handler(request);
}

async function handleGoogleSocialSignInRedirect(request: Request, env: Env): Promise<Response> {
  const signInRequest = buildGoogleSocialSignInRequest(request);
  const signInResponse = await handleBetterAuth(signInRequest, env);
  return googleSocialSignInRedirectResponse(signInResponse);
}

async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const authConfigured = missingAuthConfigKeys(env).length === 0;
  const setupRequired = !(await ownerExists(env.DB));
  const session = authConfigured ? await getAuthSession(request, env) : null;
  const membership = session ? await getActiveMembership(env.DB, session.user.id) : null;

  return json(buildAuthMeResponse({
    session,
    membership,
    setupRequired,
    authConfigured,
  }), 200);
}

async function handleSetupClaim(request: Request, env: Env): Promise<Response> {
  if (missingAuthConfigKeys(env).length > 0) {
    return json({ error: "Auth is not configured" }, 503);
  }

  const session = await getAuthSession(request, env);
  if (!session) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (await ownerExists(env.DB)) {
    return json({ error: "Setup already completed" }, 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const setupToken = isRecord(body) && typeof body.setupToken === "string" ? body.setupToken : "";
  if (!verifySetupToken(env.CODEVIL_SETUP_TOKEN, setupToken)) {
    return json({ error: "Invalid setup token" }, 403);
  }

  const now = new Date().toISOString();
  const insert = createOwnerMembershipInsert(session.user.id, now);
  await env.DB.prepare(insert.sql).bind(...insert.bindings).run();

  return json(buildAuthMeResponse({
    session,
    membership: {
      user_id: session.user.id,
      role: "owner",
      status: "active",
      created_at: now,
      updated_at: now,
    },
    setupRequired: false,
    authConfigured: true,
  }), 201);
}

async function requireAuthContext(
  request: Request,
  env: Env,
  action: AuthAction,
): Promise<AuthContext | Response> {
  if (missingAuthConfigKeys(env).length > 0) {
    return json({ error: "Auth is not configured" }, 503);
  }

  const session = await getAuthSession(request, env);
  if (!session) {
    return json({ error: "Unauthorized" }, 401);
  }

  const membership = await getActiveMembership(env.DB, session.user.id);
  if (!membership) {
    return json({ error: "Membership required" }, 403);
  }

  if (!can(membership.role, action)) {
    return json({ error: "Forbidden" }, 403);
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    ...(session.user.image ? { image: session.user.image } : {}),
    role: membership.role,
  };
}

async function getAuthSession(request: Request, env: Env): Promise<AuthSession | null> {
  const auth = createCodevilAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      ...(session.user.image ? { image: session.user.image } : {}),
    },
  };
}

async function ownerExists(db: D1Database): Promise<boolean> {
  const select = ownerExistsSelect();
  const row = await db.prepare(select.sql).bind(...select.bindings).first();
  return row !== null;
}

async function getActiveMembership(db: D1Database, userId: string): Promise<MembershipRow | null> {
  const select = activeMembershipByUserSelect(userId);
  return await db.prepare(select.sql).bind(...select.bindings).first<MembershipRow>();
}

async function getMembershipByUser(db: D1Database, userId: string): Promise<MembershipRow | null> {
  const select = membershipByUserSelect(userId);
  return await db.prepare(select.sql).bind(...select.bindings).first<MembershipRow>();
}

async function getMembershipByEmail(db: D1Database, email: string): Promise<MembershipRow | null> {
  const select = membershipByEmailSelect(email);
  return await db.prepare(select.sql).bind(...select.bindings).first<MembershipRow>();
}

async function handleListInvitations(env: Env): Promise<Response> {
  const now = new Date().toISOString();
  const select = listPendingInvitationsSelect(now);
  const result = await env.DB.prepare(select.sql).bind(...select.bindings).all<InvitationRow>();
  return json({
    invitations: (result.results ?? []).map((row) => publicInvitation(row, now)),
  }, 200);
}

async function handleCreateInvitation(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const email = isRecord(body) && typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const role = isRecord(body) ? parseInviteRole(body.role) : null;
  if (!email || !email.includes("@") || !role) {
    return json({ error: "Invalid invitation body" }, 400);
  }

  if (!canInviteRole(auth.role, role)) {
    return json({ error: "Forbidden" }, 403);
  }

  const existingMembership = await getMembershipByEmail(env.DB, email);
  if (existingMembership?.status === "active") {
    return json({ status: "already_member" }, 200);
  }
  if (existingMembership?.status === "disabled") {
    return json({ status: "member_disabled" }, 200);
  }

  const now = new Date().toISOString();
  const pending = pendingInviteByEmailSelect(email, now);
  const pendingInvite = await env.DB
    .prepare(pending.sql)
    .bind(...pending.bindings)
    .first<InvitationRow>();
  if (pendingInvite) {
    return json({
      status: "already_invited",
      invitation: publicInvitation(pendingInvite, now),
    }, 200);
  }

  const token = createInviteToken();
  const tokenHash = await hashInviteToken(token);
  const invitation: InvitationRow = {
    id: `inv_${crypto.randomUUID().replace(/-/g, "")}`,
    email,
    role,
    token_hash: tokenHash,
    invited_by_user_id: auth.userId,
    expires_at: inviteExpiresAt(new Date(now)),
    accepted_at: null,
    revoked_at: null,
    created_at: now,
    updated_at: now,
  };

  const insert = createInvitationInsert(invitation);
  await env.DB.prepare(insert.sql).bind(...insert.bindings).run();
  const url = inviteUrl(request, env, token);
  const emailDelivery = await createEmailProvider(env).sendInvite({
    invitationId: invitation.id,
    email,
    role,
    inviteUrl: url,
    invitedByName: auth.name || auth.email,
  });

  return json({
    status: "created",
    invitation: publicInvitation(invitation, now),
    invite_url: url,
    email_delivery: emailDelivery,
  }, 201);
}

async function handleGetInvite(env: Env, token: string): Promise<Response> {
  const invitation = await getInvitationByToken(env.DB, token);
  if (!invitation) {
    return json({ status: "invalid" }, 404);
  }

  const now = new Date().toISOString();
  const status = inviteStatus(invitation, now);
  return json({
    status,
    ...(status === "pending"
      ? {
          invitation: {
            email: invitation.email,
            role: invitation.role,
            expires_at: invitation.expires_at,
          },
        }
      : {}),
  }, 200);
}

async function handleAcceptInvite(request: Request, env: Env, token: string): Promise<Response> {
  if (missingAuthConfigKeys(env).length > 0) {
    return json({ error: "Auth is not configured" }, 503);
  }

  const session = await getAuthSession(request, env);
  if (!session) {
    return json({ error: "Unauthorized" }, 401);
  }

  const existingMembership = await getMembershipByUser(env.DB, session.user.id);
  if (existingMembership?.status === "active") {
    return json({ status: "already_member" }, 409);
  }
  if (existingMembership?.status === "disabled") {
    return json({ status: "member_disabled" }, 403);
  }

  const tokenHash = await hashInviteToken(token);
  const select = invitationByTokenHashSelect(tokenHash);
  const invitation = await env.DB
    .prepare(select.sql)
    .bind(...select.bindings)
    .first<InvitationRow>();
  if (!invitation) {
    return json({ status: "invalid" }, 404);
  }

  const now = new Date().toISOString();
  const status = inviteStatus(invitation, now);
  if (status !== "pending") {
    return json({ status }, 409);
  }

  const sessionEmail = normalizeEmail(session.user.email);
  if (sessionEmail !== invitation.email) {
    return json({
      status: "email_mismatch",
      expected_email: invitation.email,
      actual_email: session.user.email,
    }, 403);
  }

  const insert = createMembershipFromInviteInsert(session.user.id, tokenHash, sessionEmail, now);
  const update = acceptInvitationUpdate(invitation.id, now);
  const results = await env.DB.batch([
    env.DB.prepare(insert.sql).bind(...insert.bindings),
    env.DB.prepare(update.sql).bind(...update.bindings),
  ]);

  if (d1Changes(results[0]) !== 1 || d1Changes(results[1]) !== 1) {
    return json({ status: "no_longer_pending" }, 409);
  }

  return json({
    status: "accepted",
    membership: {
      role: invitation.role,
      status: "active",
    },
  }, 200);
}

async function handleRevokeInvitation(env: Env, invitationId: string): Promise<Response> {
  const select = invitationByIdSelect(invitationId);
  const invitation = await env.DB
    .prepare(select.sql)
    .bind(...select.bindings)
    .first<InvitationRow>();
  if (!invitation) {
    return json({ error: "Invitation not found" }, 404);
  }

  const now = new Date().toISOString();
  const status = inviteStatus(invitation, now);
  if (status !== "pending") {
    return json({ status }, 409);
  }

  const update = revokeInvitationUpdate(invitationId, now);
  const result = await env.DB.prepare(update.sql).bind(...update.bindings).run();
  if (d1Changes(result) !== 1) {
    return json({ status: "no_longer_pending" }, 409);
  }

  return json({ status: "revoked" }, 200);
}

async function getInvitationByToken(db: D1Database, token: string): Promise<InvitationRow | null> {
  const tokenHash = await hashInviteToken(token);
  const select = invitationByTokenHashSelect(tokenHash);
  return await db.prepare(select.sql).bind(...select.bindings).first<InvitationRow>();
}

function publicInvitation(invitation: InvitationRow, now: string): {
  id: string;
  email: string;
  role: InvitationRow["role"];
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
} {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: inviteStatus(invitation, now),
    expires_at: invitation.expires_at,
    created_at: invitation.created_at,
  };
}

function inviteUrl(request: Request, env: Env, token: string): string {
  const configuredOrigin = configuredWebOrigins(env)[0];
  const origin = configuredOrigin ?? new URL(request.url).origin;
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

function d1Changes(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0);
}

async function handleCreateSession(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  let normalized: ReturnType<typeof normalizeCreateSessionBody>;
  try {
    normalized = normalizeCreateSessionBody(body);
  } catch (error) {
    return json({
      error: "Invalid session body",
      detail: error instanceof Error ? error.message : String(error),
    }, 400);
  }

  const sessionId = `ses_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();
  const row: SessionDirectoryRow = {
    id: sessionId,
    repo: normalized.repo,
    title: normalized.title,
    provider: normalized.provider,
    plan_model: normalized.plan_model,
    exec_model: normalized.exec_model,
    max_cost: normalized.max_cost,
    max_session_time: normalized.max_session_time,
    max_idle_time: normalized.max_idle_time,
    max_steps: normalized.max_steps,
    room_state: "initializing",
    sandbox_state: "not_started",
    created_by_id: auth.userId,
    created_by_name: auth.name,
    created_by_email: auth.email,
    created_at: now,
    updated_at: now,
    last_event_at: now,
  };
  const insert = sessionDirectoryInsert(row);
  await env.DB.prepare(insert.sql).bind(...insert.bindings).run();

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);

  try {
    await stub.init(sessionId, normalized.title, normalized.repo, {
      worker_url: new URL("/", request.url).toString().replace(/\/$/, ""),
      provider: normalized.provider,
      plan_model: normalized.plan_model,
      exec_model: normalized.exec_model,
      max_cost: normalized.max_cost,
      max_time: normalized.max_session_time,
      max_steps: normalized.max_steps,
      created_by: { id: auth.userId, name: auth.name },
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failure = sessionDirectoryFailureUpdate(sessionId, failedAt);
    await env.DB.prepare(failure.sql).bind(...failure.bindings).run();
    console.error("session.init.failed", {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({
      error: "Failed to initialize session",
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }

  return json({
    session_id: sessionId,
    ws_url: new URL(`/sessions/${sessionId}/ws`, request.url).toString(),
    summary: buildSessionSummary(row),
  }, 201);
}

async function handleListSessions(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const select = recentSessionsSelect(cutoff, limit);
  const result = await env.DB
    .prepare(select.sql)
    .bind(...select.bindings)
    .all<SessionDirectoryRow>();

  return json({
    sessions: (result.results ?? []).map(buildSessionSummary),
  }, 200);
}

async function handleGetSession(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const select = sessionByIdSelect(sessionId);
  const row = await env.DB
    .prepare(select.sql)
    .bind(...select.bindings)
    .first<SessionDirectoryRow>();

  if (!row) {
    return json({ error: "Session not found" }, 404);
  }

  return json({
    session: buildSessionSummary(row),
    ws_url: new URL(`/sessions/${sessionId}/ws`, request.url).toString(),
  }, 200);
}

async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  sessionId: string,
  auth: AuthContext,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return json({ error: "Expected Upgrade: websocket" }, 426);
  }

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  const forwarded = requestWithAuthenticatedParticipant(request, auth);
  return stub.fetch(forwarded);
}

function requestWithAuthenticatedParticipant(request: Request, auth: AuthContext): Request {
  const url = new URL(request.url);
  url.searchParams.delete("participant_id");
  url.searchParams.delete("name");
  url.searchParams.delete("token");
  url.searchParams.delete("auth_user_id");
  url.searchParams.delete("auth_email");
  url.searchParams.delete("auth_name");
  url.searchParams.delete("auth_role");
  url.searchParams.set("participant_id", auth.userId);
  url.searchParams.set("name", auth.name || auth.email);
  url.searchParams.set("auth_user_id", auth.userId);
  url.searchParams.set("auth_email", auth.email);
  url.searchParams.set("auth_name", auth.name || auth.email);
  url.searchParams.set("auth_role", auth.role);
  return new Request(url.toString(), request);
}

async function handleSandboxWebSocketUpgrade(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return json({ error: "Expected Upgrade: websocket" }, 426);
  }

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  return stub.fetch(request);
}

async function handleSessionPreview(
  request: Request,
  env: Env,
  sessionId: string,
  token: string,
): Promise<Response> {
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  return stub.fetchPreview(request, token);
}

async function handleLogs(env: Env, sessionId: string): Promise<Response> {
  try {
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getCodevilSandbox(
      getSandbox,
      env.Sandbox as unknown as Parameters<typeof getSandbox>[0],
      sessionId,
    );
    const logs = await sandbox.getProcessLogs("codevil-agent");
    return json(logs, 200);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

async function handleSimulate(env: Env, sessionId: string): Promise<Response> {
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  await stub.simulateTestEvents();
  return json({ ok: true }, 200);
}

function json(data: unknown, status: number): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
