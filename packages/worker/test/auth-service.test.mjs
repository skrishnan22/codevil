import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthMeResponse,
  verifySetupToken,
} from "../dist/auth-service.js";

const user = {
  id: "usr_123",
  email: "alice@example.com",
  name: "Alice",
  image: "https://example.com/alice.png",
};

test("buildAuthMeResponse returns setup state for unauthenticated browsers", () => {
  assert.deepEqual(buildAuthMeResponse({
    session: null,
    membership: null,
    setupRequired: true,
    authConfigured: true,
  }), {
    authenticated: false,
    setupRequired: true,
    authConfigured: true,
  });
});

test("buildAuthMeResponse includes user without membership for setup and invite flows", () => {
  assert.deepEqual(buildAuthMeResponse({
    session: { user },
    membership: null,
    setupRequired: true,
    authConfigured: true,
  }), {
    authenticated: true,
    setupRequired: true,
    authConfigured: true,
    user,
  });
});

test("buildAuthMeResponse includes active membership when present", () => {
  assert.deepEqual(buildAuthMeResponse({
    session: { user },
    membership: {
      user_id: "usr_123",
      role: "owner",
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
      updated_at: "2026-06-11T00:00:00.000Z",
    },
    setupRequired: false,
    authConfigured: true,
  }), {
    authenticated: true,
    setupRequired: false,
    authConfigured: true,
    user,
    membership: {
      role: "owner",
      status: "active",
    },
  });
});

test("verifySetupToken requires exact configured token match", () => {
  assert.equal(verifySetupToken("secret-token", "secret-token"), true);
  assert.equal(verifySetupToken("secret-token", "wrong"), false);
  assert.equal(verifySetupToken("secret-token", ""), false);
});
