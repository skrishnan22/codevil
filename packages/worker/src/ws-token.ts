import { AuthRoleSchema } from "@codevil/shared";
import { isRecord } from "@codevil/shared";
import { createCapabilityToken, verifyCapabilityToken } from "./capability-token.js";
import type { SocketAuthContext } from "./ws-authorization.js";

const SOCKET_AUTH_AUDIENCE = "socket_auth";

/** Short TTL — token is only used during the WebSocket upgrade handshake. */
export const SOCKET_AUTH_TOKEN_TTL_SECONDS = 5 * 60;

interface SocketAuthClaims {
  uid: string;
  email: string;
  name: string;
  role: SocketAuthContext["role"];
  sid: string;
}

export function sessionIdFromWebSocketPath(pathname: string): string | null {
  const match = pathname.match(/\/sessions\/([^/]+)\/ws$/);
  return match?.[1] ?? null;
}

export async function createSocketAuthToken(
  auth: SocketAuthContext,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const claims: SocketAuthClaims = {
    uid: auth.userId,
    email: auth.email,
    name: auth.name,
    role: auth.role,
    sid: sessionId,
  };
  return createCapabilityToken(secret, {
    audience: SOCKET_AUTH_AUDIENCE,
    claims,
    nowSeconds: Math.floor(now / 1000),
    ttlSeconds: SOCKET_AUTH_TOKEN_TTL_SECONDS,
  });
}

export async function verifySocketAuthToken(
  token: string | null | undefined,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<SocketAuthContext | null> {
  const envelope = await verifyCapabilityToken<Partial<SocketAuthClaims>>(token, secret, {
    audience: SOCKET_AUTH_AUDIENCE,
    nowSeconds: Math.floor(now / 1000),
    maxLifetimeSeconds: SOCKET_AUTH_TOKEN_TTL_SECONDS,
  });
  if (!envelope) return null;

  const claims = envelope.claims;
  if (!isRecord(claims)) return null;
  if (claims.sid !== sessionId) return null;
  if (typeof claims.uid !== "string" || claims.uid.length === 0) return null;
  if (typeof claims.email !== "string" || claims.email.length === 0) return null;

  const role = AuthRoleSchema.safeParse(claims.role);
  if (!role.success) return null;

  return {
    userId: claims.uid,
    email: claims.email,
    name: typeof claims.name === "string" && claims.name.length > 0 ? claims.name : claims.email,
    role: role.data,
  };
}
