import {
  buildCreateSessionResponse,
  buildSessionSummary,
  legacyDirectoryGuardColumns,
  normalizeCreateSessionBody,
  normalizeIdempotencyKey,
  recentSessionsSelect,
  sessionByIdSelect,
  sessionDirectoryFailureUpdate,
  sessionDirectoryInsert,
  sessionIdempotencyInsert,
  sessionIdempotencyLookup,
  SESSION_IDEMPOTENCY_HEADER,
  type SessionDirectoryRow,
} from "./session-directory.js";
import { createCodevilAuth } from "./auth.js";
import { workerLogSessionException } from "./logging.js";
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
  revokeInvitationUpdate,
  type InvitationStatus,
} from "./invitations.js";
import { buildAuthMeResponse, verifySetupToken, type AuthSession } from "./auth-service.js";
import {
  buildGoogleSocialSignInRequest,
  googleSocialSignInRedirectResponse,
} from "./auth-redirect.js";
import { configuredWebOrigins, missingAuthConfigKeys } from "./auth-config.js";
import { createEmailProvider } from "./email.js";
import { can, isRecord, type AuthAction, CreateInvitationRequestSchema, SetupClaimRequestSchema } from "@codevil/shared";
import {
  getCodevilSandbox,
  readSandboxDiagnostics,
} from "./sandbox.js";
import type { Env } from "./worker-env.js";
import type { SocketAuthContext } from "./ws-authorization.js";
import { createSocketAuthToken } from "./ws-token.js";

export function authenticate(request: Request, apiKey: string): boolean {
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

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  image?: string;
  role: MembershipRow["role"];
}

export function previewTokenFromHost(hostname: string): { sessionId: string; token: string } | null {
  const label = hostname.split(".", 1)[0];
  const match = label.match(/^(ses-[a-f0-9]{32})-[a-f0-9]{24}$/);
  if (!match) return null;
  return {
    sessionId: match[1].replace(/^ses-/, "ses_"),
    token: label,
  };
}

export async function handleBetterAuth(request: Request, env: Env): Promise<Response> {
  const missing = missingAuthConfigKeys(env);
  if (missing.length > 0) {
    return json({
      error: "Auth is not configured",
      missing,
    }, 503);
  }

  const auth = createCodevilAuth(env, new URL(request.url).origin);
  return auth.handler(request);
}

export async function handleGoogleSocialSignInRedirect(request: Request, env: Env): Promise<Response> {
  const signInRequest = buildGoogleSocialSignInRequest(request);
  const signInResponse = await handleBetterAuth(signInRequest, env);
  return googleSocialSignInRedirectResponse(signInResponse);
}

export async function handleAuthMe(request: Request, env: Env): Promise<Response> {
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

export async function handleSetupClaim(request: Request, env: Env): Promise<Response> {
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

  const parsed = SetupClaimRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid setup body", issues: parsed.error.issues }, 400);
  }

  if (!verifySetupToken(env.CODEVIL_SETUP_TOKEN, parsed.data.setupToken)) {
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

export async function requireAuthContext(
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
  const auth = createCodevilAuth(env, new URL(request.url).origin);
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

export async function handleListInvitations(env: Env): Promise<Response> {
  const now = new Date().toISOString();
  const select = listPendingInvitationsSelect(now);
  const result = await env.DB.prepare(select.sql).bind(...select.bindings).all<InvitationRow>();
  return json({
    invitations: (result.results ?? []).map((row) => publicInvitation(row, now)),
  }, 200);
}

export async function handleCreateInvitation(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = CreateInvitationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid invitation body", issues: parsed.error.issues }, 400);
  }

  const email = normalizeEmail(parsed.data.email);
  const role = parsed.data.role;
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

export async function handleGetInvite(env: Env, token: string): Promise<Response> {
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

export async function handleAcceptInvite(request: Request, env: Env, token: string): Promise<Response> {
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

export async function handleRevokeInvitation(env: Env, invitationId: string): Promise<Response> {
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

export async function handleCreateSession(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  let idempotencyKey: string | null = null;
  try {
    idempotencyKey = normalizeIdempotencyKey(request.headers.get(SESSION_IDEMPOTENCY_HEADER));
  } catch (error) {
    return json({
      error: "Invalid Idempotency-Key",
      detail: error instanceof Error ? error.message : String(error),
    }, 400);
  }

  if (idempotencyKey) {
    const lookup = sessionIdempotencyLookup(auth.userId, idempotencyKey);
    const existing = await env.DB
      .prepare(lookup.sql)
      .bind(...lookup.bindings)
      .first<{ session_id: string }>();
    if (existing) {
      const select = sessionByIdSelect(existing.session_id);
      const row = await env.DB
        .prepare(select.sql)
        .bind(...select.bindings)
        .first<SessionDirectoryRow>();
      if (row) {
        return json(
          buildCreateSessionResponse(existing.session_id, request.url, row),
          200,
        );
      }
    }
  }

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
  const legacyGuards = legacyDirectoryGuardColumns();
  const row: SessionDirectoryRow = {
    id: sessionId,
    repo: normalized.repo,
    title: normalized.title,
    provider: normalized.provider,
    plan_model: normalized.plan_model,
    exec_model: normalized.exec_model,
    max_cost: legacyGuards.max_cost,
    max_session_time: normalized.max_session_time,
    max_idle_time: normalized.max_idle_time,
    max_steps: legacyGuards.max_steps,
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
  const statements = [env.DB.prepare(insert.sql).bind(...insert.bindings)];
  if (idempotencyKey) {
    const idempotency = sessionIdempotencyInsert({
      user_id: auth.userId,
      idempotency_key: idempotencyKey,
      session_id: sessionId,
      created_at: now,
    });
    statements.push(env.DB.prepare(idempotency.sql).bind(...idempotency.bindings));
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (idempotencyKey) {
      const lookup = sessionIdempotencyLookup(auth.userId, idempotencyKey);
      const existing = await env.DB
        .prepare(lookup.sql)
        .bind(...lookup.bindings)
        .first<{ session_id: string }>();
      if (existing) {
        const select = sessionByIdSelect(existing.session_id);
        const existingRow = await env.DB
          .prepare(select.sql)
          .bind(...select.bindings)
          .first<SessionDirectoryRow>();
        if (existingRow) {
          return json(
            buildCreateSessionResponse(existing.session_id, request.url, existingRow),
            200,
          );
        }
      }
    }
    throw error;
  }

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);

  try {
    await stub.init(sessionId, normalized.title, normalized.repo, {
      worker_url: new URL("/", request.url).toString().replace(/\/$/, ""),
      provider: normalized.provider,
      plan_model: normalized.plan_model,
      exec_model: normalized.exec_model,
      max_time: normalized.max_session_time,
      created_by: { id: auth.userId, name: auth.name },
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failure = sessionDirectoryFailureUpdate(sessionId, failedAt);
    await env.DB.prepare(failure.sql).bind(...failure.bindings).run();
    workerLogSessionException(sessionId, "session.init.failed", error);
    return json({
      error: "Failed to initialize session",
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }

  return json(buildCreateSessionResponse(sessionId, request.url, row), 201);
}

export async function handleListSessions(
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

export async function handleGetSession(
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

export async function handleWebSocketUpgrade(
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
  const forwarded = await requestWithAuthenticatedParticipant(request, auth, sessionId, env.CODEVIL_API_KEY);
  return stub.fetch(forwarded);
}

async function requestWithAuthenticatedParticipant(
  request: Request,
  auth: AuthContext,
  sessionId: string,
  apiKey: string,
): Promise<Request> {
  const url = new URL(request.url);
  url.searchParams.delete("participant_id");
  url.searchParams.delete("name");
  url.searchParams.delete("token");
  url.searchParams.delete("auth_user_id");
  url.searchParams.delete("auth_email");
  url.searchParams.delete("auth_name");
  url.searchParams.delete("auth_role");
  url.searchParams.delete("ws_token");

  const socketAuth: SocketAuthContext = {
    userId: auth.userId,
    email: auth.email,
    name: auth.name || auth.email,
    role: auth.role,
  };
  const wsToken = await createSocketAuthToken(socketAuth, sessionId, apiKey);
  url.searchParams.set("ws_token", wsToken);
  url.searchParams.set("participant_id", auth.userId);
  url.searchParams.set("name", auth.name || auth.email);
  return new Request(url.toString(), request);
}

export async function handleSandboxWebSocketUpgrade(
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

export async function handleSessionPreview(
  request: Request,
  env: Env,
  sessionId: string,
  token: string,
): Promise<Response> {
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  return stub.fetchPreview(request, token);
}

export async function handleLogs(env: Env, sessionId: string): Promise<Response> {
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

export async function handleDiagnostics(env: Env, sessionId: string): Promise<Response> {
  try {
    return json(await readSandboxDiagnostics(env.Sandbox, sessionId, "codevil-agent"), 200);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

export function json(data: unknown, status: number): Response {
  return Response.json(data, { status });
}
