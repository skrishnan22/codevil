import { AuthRoleSchema } from "@codevil/shared";
import { isRecord } from "@codevil/shared";
import type { SocketAuthContext } from "./ws-authorization.js";

const TOKEN_VERSION = "v1";

/** Short TTL — token is only used during the WebSocket upgrade handshake. */
export const SOCKET_AUTH_TOKEN_TTL_MS = 5 * 60 * 1000;

interface SocketAuthTokenPayload {
  uid: string;
  email: string;
  name: string;
  role: SocketAuthContext["role"];
  sid: string;
  exp: number;
}

export function sessionIdFromWebSocketPath(pathname: string): string | null {
  const match = pathname.match(/\/sessions\/([^/]+)\/ws$/);
  return match?.[1] ?? null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(new TextEncoder().encode(value));
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sigBytes = base64UrlDecode(signature);
  if (!sigBytes) return false;
  return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
}

export async function createSocketAuthToken(
  auth: SocketAuthContext,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload: SocketAuthTokenPayload = {
    uid: auth.userId,
    email: auth.email,
    name: auth.name,
    role: auth.role,
    sid: sessionId,
    exp: now + SOCKET_AUTH_TOKEN_TTL_MS,
  };
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signature = await signPayload(encodedPayload, secret);
  return `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
}

export async function verifySocketAuthToken(
  token: string | null | undefined,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<SocketAuthContext | null> {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

  const encodedPayload = parts[1];
  const signature = parts[2];
  if (!encodedPayload || !signature) return null;

  if (!(await verifySignature(encodedPayload, signature, secret))) return null;

  const payloadBytes = base64UrlDecode(encodedPayload);
  if (!payloadBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (parsed.sid !== sessionId) return null;
  if (typeof parsed.exp !== "number" || parsed.exp < now) return null;

  const role = AuthRoleSchema.safeParse(parsed.role);
  if (!role.success) return null;
  if (typeof parsed.uid !== "string" || parsed.uid.length === 0) return null;
  if (typeof parsed.email !== "string" || parsed.email.length === 0) return null;

  return {
    userId: parsed.uid,
    email: parsed.email,
    name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : parsed.email,
    role: role.data,
  };
}
