import assert from "node:assert/strict";
import test from "node:test";

import {
  createSandboxWebSocketToken,
  SANDBOX_WS_TOKEN_TTL_SECONDS,
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
    exp: Math.floor(NOW / 1000) + SANDBOX_WS_TOKEN_TTL_SECONDS,
    jti: (await verifySandboxWebSocketToken(token, "ses_123", SECRET, NOW)).jti,
  });
  const replacement = await createSandboxWebSocketToken("ses_123", SECRET, NOW);
  assert.notEqual(replacement, token);
});

test("sandbox WebSocket capability rejects forged, expired, wrong-session, wrong-audience, and proxy tokens", async () => {
  const token = await createSandboxWebSocketToken("ses_123", SECRET, NOW);
  assert.equal(await verifySandboxWebSocketToken(token, "ses_wrong", SECRET, NOW), null);
  assert.equal(await verifySandboxWebSocketToken(token, "ses_123", "wrong-secret", NOW), null);
  assert.equal(await verifySandboxWebSocketToken(token, "ses_123", SECRET, NOW + SANDBOX_WS_TOKEN_TTL_SECONDS * 1000), null);
  assert.equal(await verifySandboxWebSocketToken("v1.invalid.signature", "ses_123", SECRET, NOW), null);
  assert.equal(await verifySandboxWebSocketToken("control-plane-global-key", "ses_123", SECRET, NOW), null);
  const proxyToken = await createSandboxProxyToken(SECRET, { sessionId: "ses_123", provider: "openai", api: "openai-responses" }, NOW);
  assert.equal(await verifySandboxWebSocketToken(proxyToken, "ses_123", SECRET, NOW), null);
});
