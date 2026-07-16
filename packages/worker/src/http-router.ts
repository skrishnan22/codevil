import { GOOGLE_SOCIAL_SIGN_IN_PATH } from "./auth-redirect.js";
import { handleHealth, handleReady } from "./health.js";
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
import {
  handleSlackAction,
  handleSlackCommand,
  handleSlackEvent,
  handleSlackManifest,
  handleSlackStatus,
  type SlackActionDeps,
  type SlackEventDeps,
  type SlackStatusDeps,
} from "./integrations/slack/routes.js";
import { previewPathPrefix } from "./orchestrator/preview.js";
import type { Env } from "./worker-env.js";

export interface HttpRouterDeps {
  withCors: (request: Request, env: Env, response: Response) => Response;
  slack?: SlackStatusDeps & SlackEventDeps & SlackActionDeps;
}

export async function dispatchHttpRequest(
  request: Request,
  env: Env,
  deps: HttpRouterDeps,
): Promise<Response | null> {
  const { withCors } = deps;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health" && request.method === "GET") {
    return handleHealth();
  }

  if (path === "/ready" && request.method === "GET") {
    return handleReady(env);
  }

  const hostPreview = previewTokenFromHost(url.hostname);
  if (hostPreview) {
    return handleSessionPreview(request, env, hostPreview.sessionId, hostPreview.token);
  }

  const previewMatch = path.match(/^\/sessions\/([^/]+)\/preview\/([^/]+)(?:\/.*)?$/);
  if (previewMatch) {
    return handleSessionPreview(request, env, previewMatch[1], previewMatch[2]);
  }

  const refererPreview = previewTokenFromSameOriginReferer(request, url);
  if (refererPreview) {
    return handleSessionPreview(
      rewriteEscapedPreviewRequest(request, url, refererPreview),
      env,
      refererPreview.sessionId,
      refererPreview.token,
    );
  }

  if (path === "/slack/commands" && request.method === "POST") {
    return await handleSlackCommand(request, env);
  }

  if (path === "/slack/events" && request.method === "POST") {
    return await handleSlackEvent(request, env, deps.slack);
  }

  if (path === "/slack/actions" && request.method === "POST") {
    return await handleSlackAction(request, env, deps.slack);
  }

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

  if (path === "/auth/me" && request.method === "GET") {
    return withCors(request, env, await handleAuthMe(request, env));
  }

  if (path === "/setup/claim" && request.method === "POST") {
    return withCors(request, env, await handleSetupClaim(request, env));
  }

  if (path === "/integrations/slack/manifest" && request.method === "GET") {
    const auth = await requireAuthContext(request, env, "members:invite");
    if (auth instanceof Response) return withCors(request, env, auth);
    return withCors(request, env, await handleSlackManifest(request));
  }

  if (path === "/integrations/slack/status" && request.method === "GET") {
    const auth = await requireAuthContext(request, env, "members:invite");
    if (auth instanceof Response) return withCors(request, env, auth);
    return withCors(request, env, await handleSlackStatus(env, deps.slack));
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

function previewTokenFromSameOriginReferer(
  request: Request,
  requestUrl: URL,
): { sessionId: string; token: string } | null {
  const referer = request.headers.get("referer");
  if (!referer) return null;

  let refererUrl: URL;
  try {
    refererUrl = new URL(referer);
  } catch {
    return null;
  }

  if (refererUrl.origin !== requestUrl.origin) return null;
  const match = refererUrl.pathname.match(/^\/sessions\/([^/]+)\/preview\/([^/]+)(?:\/.*)?$/);
  if (!match) return null;
  return { sessionId: match[1], token: match[2] };
}

function rewriteEscapedPreviewRequest(
  request: Request,
  requestUrl: URL,
  preview: { sessionId: string; token: string },
): Request {
  const rewrittenUrl = new URL(requestUrl);
  rewrittenUrl.pathname = [
    previewPathPrefix(preview.sessionId, preview.token),
    requestUrl.pathname.replace(/^\//, ""),
  ].join("");
  return new Request(rewrittenUrl, request);
}
