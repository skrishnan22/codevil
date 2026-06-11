import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_SESSION_EXPIRES_IN_SECONDS,
  AUTH_SESSION_UPDATE_AGE_SECONDS,
  buildAuthOptions,
  configuredWebOrigins,
  missingAuthConfigKeys,
} from "../dist/auth-config.js";

const baseEnv = {
  DB: {},
  BETTER_AUTH_URL: "https://codevil.example.com",
  BETTER_AUTH_SECRET: "x".repeat(32),
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

test("missingAuthConfigKeys reports absent required auth settings", () => {
  assert.deepEqual(missingAuthConfigKeys({ DB: {} }), [
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ]);
});

test("missingAuthConfigKeys accepts configured auth env", () => {
  assert.deepEqual(missingAuthConfigKeys(baseEnv), []);
});

test("buildAuthOptions uses D1 database and Google provider", () => {
  const options = buildAuthOptions(baseEnv);

  assert.equal(options.database, baseEnv.DB);
  assert.equal(options.baseURL, "https://codevil.example.com");
  assert.equal(options.secret, baseEnv.BETTER_AUTH_SECRET);
  assert.equal(options.socialProviders.google.clientId, "google-client");
  assert.equal(options.socialProviders.google.clientSecret, "google-secret");
});

test("buildAuthOptions configures v1 session lifetime", () => {
  const options = buildAuthOptions(baseEnv);

  assert.equal(options.session.expiresIn, AUTH_SESSION_EXPIRES_IN_SECONDS);
  assert.equal(options.session.updateAge, AUTH_SESSION_UPDATE_AGE_SECONDS);
  assert.equal(options.session.expiresIn, 14 * 24 * 60 * 60);
  assert.equal(options.session.updateAge, 24 * 60 * 60);
});

test("configuredWebOrigins parses comma-separated web origins", () => {
  assert.deepEqual(configuredWebOrigins({
    CODEVIL_WEB_ORIGIN: "https://app.example.com, http://localhost:5173/",
  }), ["https://app.example.com", "http://localhost:5173"]);
});

test("buildAuthOptions trusts configured web origins", () => {
  const options = buildAuthOptions({
    ...baseEnv,
    CODEVIL_WEB_ORIGIN: "https://app.example.com",
  });

  assert.deepEqual(options.trustedOrigins, ["https://app.example.com"]);
});
