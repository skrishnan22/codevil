import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInviteEmail,
  createEmailProvider,
  createResendEmailProvider,
} from "../dist/email.js";

const invitation = {
  invitationId: "inv_123",
  email: "alice@example.com",
  role: "developer",
  inviteUrl: "https://app.example.com/invite/inv_token",
  invitedByName: "Owner",
};

test("createEmailProvider defaults to none provider when email is not configured", async () => {
  const provider = createEmailProvider({});
  const result = await provider.sendInvite(invitation);

  assert.deepEqual(result, {
    provider: "none",
    status: "not_configured",
  });
});

test("createEmailProvider selects Resend only when all Resend settings are present", async () => {
  assert.equal(createEmailProvider({ EMAIL_PROVIDER: "resend" }).name, "none");
  assert.equal(createEmailProvider({
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_123",
    RESEND_FROM: "Codevil <onboarding@example.com>",
  }).name, "resend");
});

test("buildInviteEmail includes the invite URL in text and HTML bodies", () => {
  const email = buildInviteEmail(invitation, "Codevil");

  assert.equal(email.to, "alice@example.com");
  assert.equal(email.subject, "Join Codevil");
  assert.match(email.text, /https:\/\/app\.example\.com\/invite\/inv_token/);
  assert.match(email.html, /https:\/\/app\.example\.com\/invite\/inv_token/);
  assert.match(email.html, /developer/);
});

test("Resend provider posts the expected HTTP request", async () => {
  const requests = [];
  const provider = createResendEmailProvider({
    apiKey: "re_123",
    from: "Codevil <onboarding@example.com>",
    appName: "Codevil",
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ id: "email_123" }, { status: 200 });
    },
  });

  const result = await provider.sendInvite(invitation);

  assert.deepEqual(result, {
    provider: "resend",
    status: "sent",
    messageId: "email_123",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer re_123");
  assert.equal(requests[0].init.headers["User-Agent"], "codevil/1.0");
  assert.equal(requests[0].init.headers["Idempotency-Key"], "codevil-invite-inv_123");

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.from, "Codevil <onboarding@example.com>");
  assert.deepEqual(body.to, ["alice@example.com"]);
  assert.equal(body.subject, "Join Codevil");
  assert.match(body.html, /https:\/\/app\.example\.com\/invite\/inv_token/);
  assert.match(body.text, /https:\/\/app\.example\.com\/invite\/inv_token/);
});

test("Resend provider reports send failures without throwing", async () => {
  const provider = createResendEmailProvider({
    apiKey: "re_123",
    from: "Codevil <onboarding@example.com>",
    appName: "Codevil",
    fetcher: async () => Response.json({ message: "bad sender" }, { status: 422 }),
  });

  const result = await provider.sendInvite(invitation);

  assert.deepEqual(result, {
    provider: "resend",
    status: "failed",
    error: "bad sender",
  });
});

test("Resend provider reports network failures without throwing", async () => {
  const provider = createResendEmailProvider({
    apiKey: "re_123",
    from: "Codevil <onboarding@example.com>",
    appName: "Codevil",
    fetcher: async () => {
      throw new Error("network unavailable");
    },
  });

  const result = await provider.sendInvite(invitation);

  assert.deepEqual(result, {
    provider: "resend",
    status: "failed",
    error: "network unavailable",
  });
});
