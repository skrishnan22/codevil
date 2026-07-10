import assert from "node:assert/strict";
import test from "node:test";

import {
  createSandboxWebSocketToken,
  SANDBOX_WS_TOKEN_TTL_MS,
  verifySandboxWebSocketToken,
} from "../dist/sandbox-ws-token.js";
import { createSandboxProxyToken } from "../dist/sandbox-proxy.js";

const SECRET = "sandbox-ws-signing-secret";
const NOW = 1_700_000_000_000;

test("session-bound sandbox WebSocket capability verifies with its explicit audience and role", async () => {
  const token = await createSandboxWebSocketToken("ses_123", SECRET, NOW);
  assert.deepEqual(await verifySandboxWebSocketToken(token, "ses_123", SECRET, NOW), {
    aud: "sandbox_ws",
    role: "sandbox",
    sid: "ses_123",
    exp: NOW + SANDBOX_WS_TOKEN_TTL_MS,
    jti: (await verifySandboxWebSocketToken(token, "ses_123", SECRET, NOW)).jti,
  });
  const replacement = await createSandboxWebSocketToken("ses_123", SECRET, NOW);
  assert.notEqual(replacement, token);
});

test("sandbox WebSocket capability rejects forged, expired, wrong-session, wrong-audience, and proxy tokens", async () => {
  const token = await createSandboxWebSocketToken("ses_123", SECRET, NOW);
  assert.equal(await verifySandboxWebSocketToken(token, "ses_wrong", SECRET, NOW), null);
  assert.equal(await verifySandboxWebSocketToken(token, "ses_123", "wrong-secret", NOW), null);
  assert.equal(await verifySandboxWebSocketToken(token, "ses_123", SECRET, NOW + SANDBOX_WS_TOKEN_TTL_MS), null);
  assert.equal(await verifySandboxWebSocketToken("v1.invalid.signature", "ses_123", SECRET, NOW), null);
  assert.equal(await verifySandboxWebSocketToken("control-plane-global-key", "ses_123", SECRET, NOW), null);
  assert.equal(await verifySandboxWebSocketToken(await signClaims({
    aud: "llm_proxy",
    role: "sandbox",
    sid: "ses_123",
    exp: NOW + 1,
    jti: "wrong-audience",
  }), "ses_123", SECRET, NOW), null);
  const proxyToken = await createSandboxProxyToken(SECRET, { sessionId: "ses_123", provider: "openai", api: "openai-responses" }, NOW);
  assert.equal(await verifySandboxWebSocketToken(proxyToken, "ses_123", SECRET, NOW), null);
});

async function signClaims(claims) {
  const encoded = base64url(JSON.stringify(claims));
  const signed = `sws1.${encoded}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = base64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)))));
  return `${signed}.${signature}`;
}

function base64url(value) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
