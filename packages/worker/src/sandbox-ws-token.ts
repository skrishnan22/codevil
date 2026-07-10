const TOKEN_VERSION = "sws1";

/** The sandbox process refreshes this over its authenticated socket well before expiry. */
export const SANDBOX_WS_TOKEN_TTL_MS = 15 * 60 * 1000;

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
  if (!secret.trim()) throw new Error("CODEVIL_PROXY_SIGNING_SECRET is not configured");
  const payload: SandboxWebSocketClaims = {
    aud: "sandbox_ws",
    role: "sandbox",
    sid: sessionId,
    exp: now + SANDBOX_WS_TOKEN_TTL_MS,
    // A fresh identifier makes refreshes actual rotations even within one clock tick.
    jti: crypto.randomUUID(),
  };
  const encoded = base64url(JSON.stringify(payload));
  const signed = `${TOKEN_VERSION}.${encoded}`;
  return `${signed}.${await signature(secret, signed)}`;
}

export async function verifySandboxWebSocketToken(
  token: string | null | undefined,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<SandboxWebSocketClaims | null> {
  if (!token || !secret.trim()) return null;
  const [version, encoded, supplied, ...extra] = token.split(".");
  if (extra.length || version !== TOKEN_VERSION || !encoded || !supplied) return null;
  const signed = `${version}.${encoded}`;
  if (!await timingSafeEqual(await signature(secret, signed), supplied)) return null;
  try {
    const claims = JSON.parse(unbase64url(encoded)) as Partial<SandboxWebSocketClaims>;
    if (
      claims.aud !== "sandbox_ws"
      || claims.role !== "sandbox"
      || claims.sid !== sessionId
      || typeof claims.exp !== "number"
      || !Number.isFinite(claims.exp)
      || claims.exp <= now
      || typeof claims.jti !== "string"
      || claims.jti.length < 1
    ) return null;
    return claims as SandboxWebSocketClaims;
  } catch {
    return null;
  }
}

function base64url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function unbase64url(value: string): string {
  return atob(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4));
}
async function signature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))));
}
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
