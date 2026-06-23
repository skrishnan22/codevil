import assert from "node:assert/strict";
import test from "node:test";

import {
  authActionForClientMessage,
  authorizeSocketMessage,
  socketAuthFromUpgradeRequest,
} from "../dist/ws-authorization.js";
import {
  createSocketAuthToken,
  sessionIdFromWebSocketPath,
  SOCKET_AUTH_TOKEN_TTL_MS,
  verifySocketAuthToken,
} from "../dist/ws-token.js";

const SECRET = "test-api-key";
const AUTH = {
  userId: "usr_1",
  email: "a@example.com",
  name: "Alice",
  role: "developer",
};

test("authActionForClientMessage maps approvals to run approval permission", () => {
  assert.equal(authActionForClientMessage({ type: "approve" }), "runs:approve");
  assert.equal(authActionForClientMessage({ type: "approve_run", run_id: "run_1" }), "runs:approve");
});

test("authActionForClientMessage maps preview starts to preview permission", () => {
  assert.equal(authActionForClientMessage({ type: "preview_start", app_key: "web" }), "preview:start");
});

test("authActionForClientMessage treats user-driven socket mutations as session control", () => {
  assert.equal(authActionForClientMessage({ type: "human_message", text: "hi" }), "sessions:control");
  assert.equal(authActionForClientMessage({ type: "agent_request", text: "ship it" }), "sessions:control");
  assert.equal(authActionForClientMessage({ type: "abort" }), "sessions:control");
  assert.equal(authActionForClientMessage({ type: "stop_session" }), "sessions:control");
  assert.equal(authActionForClientMessage({ type: "preview_stop" }), "sessions:control");
});

test("createSocketAuthToken round-trips through verifySocketAuthToken", async () => {
  const token = await createSocketAuthToken(AUTH, "ses_1", SECRET);
  assert.deepEqual(await verifySocketAuthToken(token, "ses_1", SECRET), AUTH);
});

test("verifySocketAuthToken rejects forged, expired, and session-mismatched tokens", async () => {
  const now = 1_700_000_000_000;
  const token = await createSocketAuthToken(AUTH, "ses_1", SECRET, now);

  assert.equal(await verifySocketAuthToken(token, "ses_2", SECRET, now), null);
  assert.equal(await verifySocketAuthToken(token, "ses_1", "wrong-secret", now), null);
  assert.equal(
    await verifySocketAuthToken(token, "ses_1", SECRET, now + SOCKET_AUTH_TOKEN_TTL_MS + 1),
    null,
  );
  assert.equal(await verifySocketAuthToken("not-a-token", "ses_1", SECRET, now), null);
});

test("socketAuthFromUpgradeRequest reads ws_token from the upgrade request", async () => {
  const token = await createSocketAuthToken(AUTH, "ses_1", SECRET);
  const request = new Request(`https://worker.example.com/sessions/ses_1/ws?ws_token=${encodeURIComponent(token)}`);

  assert.deepEqual(await socketAuthFromUpgradeRequest(request, "ses_1", SECRET), AUTH);
});

test("sessionIdFromWebSocketPath extracts the session id", () => {
  assert.equal(sessionIdFromWebSocketPath("/sessions/ses_abc/ws"), "ses_abc");
  assert.equal(sessionIdFromWebSocketPath("/other"), null);
});

test("authorizeSocketMessage allows active members with sufficient role permission", async () => {
  const result = await authorizeSocketMessage({
    auth: { userId: "usr_1", email: "a@example.com", role: "developer" },
    message: { type: "agent_request", text: "run tests" },
    loadMembership: async () => ({
      user_id: "usr_1",
      role: "developer",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  });

  assert.deepEqual(result, { ok: true, action: "sessions:control", role: "developer" });
});

test("authorizeSocketMessage denies viewers from mutating sessions over an open socket", async () => {
  const result = await authorizeSocketMessage({
    auth: { userId: "usr_1", email: "a@example.com", role: "viewer" },
    message: { type: "human_message", text: "hi" },
    loadMembership: async () => ({
      user_id: "usr_1",
      role: "viewer",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    action: "sessions:control",
    status: 403,
    message: "Forbidden",
  });
});

test("authorizeSocketMessage rechecks current membership instead of trusting socket attachment role", async () => {
  const result = await authorizeSocketMessage({
    auth: { userId: "usr_1", email: "a@example.com", role: "developer" },
    message: { type: "preview_start", app_key: "web" },
    loadMembership: async () => ({
      user_id: "usr_1",
      role: "viewer",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    action: "preview:start",
    status: 403,
    message: "Forbidden",
  });
});

test("authorizeSocketMessage denies missing auth and removed membership", async () => {
  assert.deepEqual(await authorizeSocketMessage({
    auth: null,
    message: { type: "approve" },
    loadMembership: async () => null,
  }), {
    ok: false,
    action: "runs:approve",
    status: 401,
    message: "Unauthorized",
  });

  assert.deepEqual(await authorizeSocketMessage({
    auth: { userId: "usr_1", email: "a@example.com", role: "owner" },
    message: { type: "approve" },
    loadMembership: async () => null,
  }), {
    ok: false,
    action: "runs:approve",
    status: 403,
    message: "Membership required",
  });
});
