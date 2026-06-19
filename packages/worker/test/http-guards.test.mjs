import assert from "node:assert/strict";
import test from "node:test";

import {
  isAppShellNavigation,
  originAllowed,
  isOriginGuardedPath,
  requireTrustedOrigin,
  trustedOrigins,
} from "../dist/http-guards.js";

test("isAppShellNavigation recognizes browser navigation", () => {
  const request = new Request("https://codevil.example.com/invite/inv_123", {
    headers: { accept: "text/html,application/xhtml+xml" },
  });

  assert.equal(isAppShellNavigation(request), true);
  assert.equal(isAppShellNavigation(new Request(request.url)), false);
  assert.equal(isAppShellNavigation(new Request(request.url, {
    method: "POST",
    headers: { accept: "text/html" },
  })), false);
});

test("trustedOrigins includes request origin, auth origin, and configured web origins", () => {
  const origins = trustedOrigins(
    new Request("https://worker.example.com/sessions", {
      method: "POST",
      headers: { Origin: "https://app.example.com" },
    }),
    {
      BETTER_AUTH_URL: "https://codevil.example.com/",
      CODEVIL_WEB_ORIGIN: "https://app.example.com, http://localhost:5173/",
    },
  );

  assert.deepEqual(origins, [
    "https://worker.example.com",
    "https://codevil.example.com",
    "https://app.example.com",
    "http://localhost:5173",
  ]);
});

test("originAllowed accepts absent Origin for non-browser clients", () => {
  const request = new Request("https://worker.example.com/sessions", { method: "POST" });

  assert.equal(originAllowed(request, {}), true);
});

test("originAllowed accepts same-origin requests", () => {
  const request = new Request("https://worker.example.com/sessions", {
    method: "POST",
    headers: { Origin: "https://worker.example.com" },
  });

  assert.equal(originAllowed(request, {}), true);
});

test("originAllowed accepts configured web origins", () => {
  const request = new Request("https://worker.example.com/sessions", {
    method: "POST",
    headers: { Origin: "https://app.example.com/" },
  });

  assert.equal(originAllowed(request, { CODEVIL_WEB_ORIGIN: "https://app.example.com" }), true);
});

test("originAllowed rejects unexpected browser origins", () => {
  const request = new Request("https://worker.example.com/sessions", {
    method: "POST",
    headers: { Origin: "https://evil.example.com" },
  });

  assert.equal(originAllowed(request, { CODEVIL_WEB_ORIGIN: "https://app.example.com" }), false);
});

test("requireTrustedOrigin returns a 403 response for unexpected origins", async () => {
  const request = new Request("https://worker.example.com/sessions", {
    method: "POST",
    headers: { Origin: "https://evil.example.com" },
  });

  const response = requireTrustedOrigin(request, { CODEVIL_WEB_ORIGIN: "https://app.example.com" });

  assert.equal(response instanceof Response, true);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted origin" });
});

test("requireTrustedOrigin returns null for trusted origins", () => {
  const request = new Request("https://worker.example.com/sessions", {
    method: "POST",
    headers: { Origin: "https://app.example.com" },
  });

  assert.equal(requireTrustedOrigin(request, { CODEVIL_WEB_ORIGIN: "https://app.example.com" }), null);
});

test("isOriginGuardedPath covers state-changing browser routes", () => {
  assert.equal(isOriginGuardedPath("POST", "/setup/claim"), true);
  assert.equal(isOriginGuardedPath("POST", "/invitations"), true);
  assert.equal(isOriginGuardedPath("POST", "/invitations/inv_123/revoke"), true);
  assert.equal(isOriginGuardedPath("POST", "/invite/inv_token/accept"), true);
  assert.equal(isOriginGuardedPath("POST", "/sessions"), true);
  assert.equal(isOriginGuardedPath("POST", "/sessions/ses_123/simulate"), true);
  assert.equal(isOriginGuardedPath("POST", "/api/auth/sign-out"), true);
});

test("isOriginGuardedPath leaves read-only routes unguarded", () => {
  assert.equal(isOriginGuardedPath("GET", "/auth/me"), false);
  assert.equal(isOriginGuardedPath("GET", "/invitations"), false);
  assert.equal(isOriginGuardedPath("GET", "/invite/inv_token"), false);
  assert.equal(isOriginGuardedPath("GET", "/sessions"), false);
  assert.equal(isOriginGuardedPath("GET", "/api/auth/callback/google"), false);
});
