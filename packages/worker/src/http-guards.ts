import { configuredWebOrigins } from "./auth-config.js";

export interface TrustedOriginEnv {
  BETTER_AUTH_URL?: string;
  CODEVIL_WEB_ORIGIN?: string;
}

export function trustedOrigins(request: Request, env: TrustedOriginEnv): string[] {
  const origins = [
    new URL(request.url).origin,
    originFromUrl(env.BETTER_AUTH_URL),
    ...configuredWebOrigins(env),
  ].filter((origin): origin is string => Boolean(origin));

  return [...new Set(origins)];
}

export function originAllowed(request: Request, env: TrustedOriginEnv): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  return normalized !== null && trustedOrigins(request, env).includes(normalized);
}

export function requireTrustedOrigin(request: Request, env: TrustedOriginEnv): Response | null {
  if (originAllowed(request, env)) return null;
  return Response.json({ error: "Untrusted origin" }, { status: 403 });
}

export function isOriginGuardedPath(method: string, path: string): boolean {
  if (method !== "POST") return false;
  if (path === "/setup/claim") return true;
  if (path === "/api/auth/sign-out") return true;
  if (path === "/invitations") return true;
  if (path === "/sessions") return true;
  if (/^\/invitations\/[^/]+\/revoke$/.test(path)) return true;
  if (/^\/invite\/[^/]+\/accept$/.test(path)) return true;
  if (/^\/sessions\/[^/]+\/simulate$/.test(path)) return true;
  return false;
}

function originFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
