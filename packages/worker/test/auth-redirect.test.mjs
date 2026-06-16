import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGoogleSocialSignInRequest,
  googleSocialSignInRedirectResponse,
} from "../dist/auth-redirect.js";

test("buildGoogleSocialSignInRequest converts top-level GET into Better Auth social POST", async () => {
  const request = new Request(
    "https://api.example.com/api/auth/sign-in/google?callbackURL=https%3A%2F%2Fapp.example.com%2Fsetup",
  );

  const signInRequest = buildGoogleSocialSignInRequest(request);

  assert.equal(signInRequest.method, "POST");
  assert.equal(signInRequest.url, "https://api.example.com/api/auth/sign-in/social");
  assert.equal(signInRequest.headers.get("Content-Type"), "application/json");
  assert.equal(signInRequest.headers.get("Origin"), "https://api.example.com");
  assert.deepEqual(await signInRequest.json(), {
    provider: "google",
    callbackURL: "https://app.example.com/setup",
    errorCallbackURL: "https://app.example.com/setup",
  });
});

test("googleSocialSignInRedirectResponse preserves auth cookies and redirects to provider", async () => {
  const signInResponse = Response.json(
    { redirect: true, url: "https://accounts.google.com/oauth" },
    {
      headers: {
        "Set-Cookie": "better-auth.state=abc; Path=/; HttpOnly; Secure; SameSite=None",
      },
    },
  );

  const response = await googleSocialSignInRedirectResponse(signInResponse);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://accounts.google.com/oauth");
  assert.match(response.headers.get("Set-Cookie") ?? "", /better-auth\.state=abc/);
  assert.equal(await response.text(), "");
});
