import assert from "node:assert/strict";
import test from "node:test";

import { verifySlackSignature } from "../dist/integrations/slack/signature.js";

async function slackSignature(signingSecret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

test("verifySlackSignature accepts a valid v0 Slack HMAC", async () => {
  const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
  const timestamp = "1719513600";
  const body = "token=ignored&team_id=T123&text=hello";
  const signature = await slackSignature(signingSecret, timestamp, body);

  assert.equal(
    await verifySlackSignature({
      signingSecret,
      signature,
      timestamp,
      body,
      nowSeconds: 1719513610,
    }),
    true,
  );
});

test("verifySlackSignature rejects stale timestamps", async () => {
  const signingSecret = "secret";
  const timestamp = "1719513600";
  const body = "team_id=T123";
  const signature = await slackSignature(signingSecret, timestamp, body);

  assert.equal(
    await verifySlackSignature({
      signingSecret,
      signature,
      timestamp,
      body,
      nowSeconds: 1719514001,
    }),
    false,
  );
});

test("verifySlackSignature rejects bad signatures and missing inputs", async () => {
  assert.equal(
    await verifySlackSignature({
      signingSecret: "secret",
      signature: "v0=bad",
      timestamp: "1719513600",
      body: "team_id=T123",
      nowSeconds: 1719513600,
    }),
    false,
  );
  assert.equal(
    await verifySlackSignature({
      signingSecret: "",
      signature: "v0=bad",
      timestamp: "1719513600",
      body: "team_id=T123",
      nowSeconds: 1719513600,
    }),
    false,
  );
  assert.equal(
    await verifySlackSignature({
      signingSecret: "secret",
      signature: "v0=bad",
      timestamp: "not-a-number",
      body: "team_id=T123",
      nowSeconds: 1719513600,
    }),
    false,
  );
});
