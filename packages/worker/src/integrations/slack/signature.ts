export interface VerifySlackSignatureInput {
  signingSecret?: string;
  signature?: string;
  timestamp?: string;
  body: string;
  nowSeconds?: number;
}

const SIGNATURE_VERSION = "v0";
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export async function verifySlackSignature({
  signingSecret,
  signature,
  timestamp,
  body,
  nowSeconds,
}: VerifySlackSignatureInput): Promise<boolean> {
  if (!signingSecret || !signature || !timestamp) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expectedSignature = `${SIGNATURE_VERSION}=${await hmacSha256Hex(signingSecret, `${SIGNATURE_VERSION}:${timestamp}:${body}`)}`;
  return timingSafeEqual(signature, expectedSignature);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  const maxLength = Math.max(actualBytes.length, expectedBytes.length);
  let difference = actualBytes.length ^ expectedBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return difference === 0;
}
