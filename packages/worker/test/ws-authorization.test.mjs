import assert from "node:assert/strict";
import test from "node:test";

import {
  authActionForClientMessage,
  authorizeSocketMessage,
  socketAuthFromRequest,
} from "../dist/ws-authorization.js";

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

test("socketAuthFromRequest extracts trusted auth context from worker-internal query params", () => {
  const request = new Request("https://worker.example.com/sessions/ses_1/ws?auth_user_id=usr_1&auth_email=a%40example.com&auth_role=developer");

  assert.deepEqual(socketAuthFromRequest(request), {
    userId: "usr_1",
    email: "a@example.com",
    role: "developer",
  });
});

test("socketAuthFromRequest rejects missing or invalid auth query params", () => {
  assert.equal(socketAuthFromRequest(new Request("https://worker.example.com/sessions/ses_1/ws?auth_user_id=usr_1&auth_email=a%40example.com")), null);
  assert.equal(socketAuthFromRequest(new Request("https://worker.example.com/sessions/ses_1/ws?auth_user_id=usr_1&auth_email=a%40example.com&auth_role=root")), null);
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
