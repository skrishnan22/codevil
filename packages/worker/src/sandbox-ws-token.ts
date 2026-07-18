import { createCapabilityToken, verifyCapabilityToken } from "./capability-token.js";

/** The sandbox process refreshes this over its authenticated socket well before expiry. */
export const SANDBOX_WS_TOKEN_TTL_SECONDS = 15 * 60;

export interface SandboxWebSocketClaims {
  aud: "sandbox_ws";
  role: "sandbox";
  sid: string;
  exp: number;
  jti: string;
}

export async function createSandboxWebSocketToken(
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  return createCapabilityToken(secret, {
    audience: "sandbox_ws",
    claims: { role: "sandbox" as const, sid: sessionId },
    nowSeconds: Math.floor(now / 1000),
    ttlSeconds: SANDBOX_WS_TOKEN_TTL_SECONDS,
  });
}

export async function verifySandboxWebSocketToken(
  token: string | null | undefined,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<SandboxWebSocketClaims | null> {
  const envelope = await verifyCapabilityToken<{ role?: unknown; sid?: unknown }>(token, secret, {
    audience: "sandbox_ws",
    nowSeconds: Math.floor(now / 1000),
    maxLifetimeSeconds: SANDBOX_WS_TOKEN_TTL_SECONDS,
  });
  if (!envelope || envelope.claims.role !== "sandbox" || envelope.claims.sid !== sessionId) return null;
  return { aud: "sandbox_ws", role: "sandbox", sid: sessionId, exp: envelope.exp, jti: envelope.jti };
}
