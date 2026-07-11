const CAPABILITY_TOKEN_VERSION = "cap1";

export interface CapabilityTokenEnvelope<Claims = unknown> {
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  claims: Claims;
}

export async function createCapabilityToken<Claims>(
  secret: string,
  options: {
    audience: string;
    claims: Claims;
    ttlSeconds: number;
    nowSeconds?: number;
  },
): Promise<string> {
  if (!secret.trim()) throw new Error("Capability signing secret is not configured");
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new Error("Capability TTL must be a positive integer");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now)) throw new Error("Capability issuance time is invalid");
  const payload: CapabilityTokenEnvelope<Claims> = {
    aud: options.audience,
    iat: now,
    exp: now + options.ttlSeconds,
    jti: crypto.randomUUID(),
    claims: options.claims,
  };
  const encoded = base64url(JSON.stringify(payload));
  const signed = `${CAPABILITY_TOKEN_VERSION}.${encoded}`;
  return `${signed}.${await signature(secret, signed)}`;
}

export async function verifyCapabilityToken<Claims = unknown>(
  token: string | null | undefined,
  secret: string,
  options: {
    audience: string;
    maxLifetimeSeconds: number;
    nowSeconds?: number;
    clockSkewSeconds?: number;
  },
): Promise<CapabilityTokenEnvelope<Claims> | null> {
  if (!token || !secret.trim()) return null;
  const [version, encoded, supplied, ...extra] = token.split(".");
  if (extra.length || version !== CAPABILITY_TOKEN_VERSION || !encoded || !supplied) return null;
  const signed = `${version}.${encoded}`;
  if (!await timingSafeEqual(await signature(secret, signed), supplied)) return null;
  try {
    const payload = JSON.parse(unbase64url(encoded)) as Partial<CapabilityTokenEnvelope<Claims>>;
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const skew = options.clockSkewSeconds ?? 30;
    if (
      payload.aud !== options.audience
      || !Number.isSafeInteger(payload.iat)
      || !Number.isSafeInteger(payload.exp)
      || payload.iat! > now + skew
      || payload.exp! <= now
      || payload.exp! <= payload.iat!
      || payload.exp! - payload.iat! > options.maxLifetimeSeconds
      || typeof payload.jti !== "string"
      || payload.jti.length < 1
      || !("claims" in payload)
    ) return null;
    return payload as CapabilityTokenEnvelope<Claims>;
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
