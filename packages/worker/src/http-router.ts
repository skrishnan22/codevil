import { GOOGLE_SOCIAL_SIGN_IN_PATH } from "./auth-redirect.js";
import { isAppShellNavigation, isOriginGuardedPath, requireTrustedOrigin } from "./http-guards.js";
import {
  authenticate,
  handleAcceptInvite,
  handleAuthMe,
  handleBetterAuth,
  handleCreateInvitation,
  handleCreateSession,
  handleDiagnostics,
  handleGetInvite,
  handleGetSession,
  handleGoogleSocialSignInRedirect,
  handleListInvitations,
  handleListSessions,
  handleLogs,
  handleRevokeInvitation,
  handleSandboxWebSocketUpgrade,
  handleSessionPreview,
  handleSetupClaim,
  handleWebSocketUpgrade,
  json,
  previewTokenFromHost,
  requireAuthContext,
} from "./http-handlers.js";
import type { Env } from "./worker-env.js";

export interface HttpRouterDeps {
  withCors: (request: Request, env: Env, response: Response) => Response;
}

export async function dispatchHttpRequest(
  request: Request,
  env: Env,
  deps: HttpRouterDeps,
): Promise<Response | null> {
  const { withCors } = deps;
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

  if (path.startsWith("/invite/") && isAppShellNavigation(request)) {
    return env.ASSETS.fetch(request);
  }

  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
  if (inviteMatch && request.method === "GET") {
    return withCors(request, env, await handleGetInvite(env, inviteMatch[1]));
  }

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

  const logsMatch = path.match(/^\/sessions\/([^/]+)\/logs$/);
  if (logsMatch && request.method === "GET") {
    if (!authenticate(request, env.CODEVIL_API_KEY)) {
      return withCors(request, env, json({ error: "Unauthorized" }, 401));
    }
    return withCors(request, env, await handleLogs(env, logsMatch[1]));
  }

  const diagnosticsMatch = path.match(/^\/sessions\/([^/]+)\/diagnostics$/);
  if (diagnosticsMatch && request.method === "GET") {
    if (!authenticate(request, env.CODEVIL_API_KEY)) {
      return withCors(request, env, json({ error: "Unauthorized" }, 401));
    }
    return withCors(request, env, await handleDiagnostics(env, diagnosticsMatch[1]));
  }

  return null;
}
