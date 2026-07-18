import assert from "node:assert/strict";
import test from "node:test";

import { createCapabilityToken, verifyCapabilityToken } from "../dist/capability-token.js";

const SECRET = "capability-signing-secret";
const NOW_SECONDS = 1_800_000_000;

test("capability token round-trips bounded audience-specific claims", async () => {
  const token = await createCapabilityToken(SECRET, {
    audience: "sandbox_llm",
    claims: { sid: "ses_1", provider: "openai" },
    nowSeconds: NOW_SECONDS,
    ttlSeconds: 900,
  });

  const verified = await verifyCapabilityToken(token, SECRET, {
    audience: "sandbox_llm",
    nowSeconds: NOW_SECONDS + 1,
    maxLifetimeSeconds: 900,
  });

  assert.equal(verified?.aud, "sandbox_llm");
  assert.equal(verified?.iat, NOW_SECONDS);
  assert.equal(verified?.exp, NOW_SECONDS + 900);
  assert.equal(typeof verified?.jti, "string");
  assert.deepEqual(verified?.claims, { sid: "ses_1", provider: "openai" });
});

test("capability verification rejects wrong audience, tampering, expiry, and excessive lifetime", async () => {
  const token = await createCapabilityToken(SECRET, {
    audience: "sandbox_git",
    claims: { sid: "ses_1" },
    nowSeconds: NOW_SECONDS,
    ttlSeconds: 901,
  });

  assert.equal(await verifyCapabilityToken(token, SECRET, { audience: "sandbox_llm", nowSeconds: NOW_SECONDS, maxLifetimeSeconds: 901 }), null);
  assert.equal(await verifyCapabilityToken(`${token}x`, SECRET, { audience: "sandbox_git", nowSeconds: NOW_SECONDS, maxLifetimeSeconds: 901 }), null);
  assert.equal(await verifyCapabilityToken(token, SECRET, { audience: "sandbox_git", nowSeconds: NOW_SECONDS + 902, maxLifetimeSeconds: 901 }), null);
  assert.equal(await verifyCapabilityToken(token, SECRET, { audience: "sandbox_git", nowSeconds: NOW_SECONDS, maxLifetimeSeconds: 900 }), null);
});

test("capability verification applies bounded clock skew to issued-at time", async () => {
  const token = await createCapabilityToken(SECRET, {
    audience: "sandbox_ws",
    claims: { sid: "ses_1" },
    nowSeconds: NOW_SECONDS + 31,
    ttlSeconds: 60,
  });

  assert.ok(await verifyCapabilityToken(token, SECRET, {
    audience: "sandbox_ws",
    nowSeconds: NOW_SECONDS,
    maxLifetimeSeconds: 60,
    clockSkewSeconds: 31,
  }));
  assert.equal(await verifyCapabilityToken(token, SECRET, {
    audience: "sandbox_ws",
    nowSeconds: NOW_SECONDS,
    maxLifetimeSeconds: 60,
    clockSkewSeconds: 30,
  }), null);
});

test("capability creation rejects empty secrets and invalid lifetimes", async () => {
  await assert.rejects(() => createCapabilityToken(" ", { audience: "sandbox_git", claims: {}, nowSeconds: NOW_SECONDS, ttlSeconds: 60 }), /signing secret/i);
  await assert.rejects(() => createCapabilityToken(SECRET, { audience: "sandbox_git", claims: {}, nowSeconds: NOW_SECONDS, ttlSeconds: 0 }), /TTL/i);
});
