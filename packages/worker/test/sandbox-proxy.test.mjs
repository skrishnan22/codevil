import assert from "node:assert/strict";
import test from "node:test";

import { createSandboxGitProxyToken, createSandboxProxyToken, handleSandboxProxy } from "../dist/sandbox-proxy.js";

const secret = "proxy-signing-secret";
const env = {
  CODEVIL_PROXY_SIGNING_SECRET: secret,
  OPENAI_API_KEY: "real-provider-key",
  GITHUB_PAT: "real-github-pat",
};

test("LLM proxy rejects invalid provider target before any upstream request", async () => {
  const token = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" });
  const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/llm/openai/openai-responses/responses", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-codevil-proxy-target": "https://evil.test" },
  }), env);
  assert.equal(response.status, 403);
});

test("proxy telemetry reports normalized metadata without request paths or credentials", async () => {
  const telemetry = [];
  const token = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" });
  const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/llm/openai/openai-responses/responses?secret=query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-codevil-proxy-target": "https://evil.test/private/path" },
  }), env, (event) => telemetry.push(event));

  assert.equal(response.status, 403);
  assert.deepEqual(telemetry.map(({ durationMs, ...event }) => event), [{ kind: "llm", provider: "openai", api: "openai-responses", outcome: "rejected", status: 403, statusClass: "4xx" }]);
  assert.ok(telemetry[0].durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(telemetry), /responses\?|evil|private|real-provider-key|cap1/);
});

test("expired and provider-mismatched capabilities are rejected", async () => {
  const expired = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" }, 0);
  const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/llm/anthropic/anthropic-messages/messages", {
    method: "POST", headers: { "x-api-key": expired, "x-codevil-proxy-target": "https://api.anthropic.com" },
  }), env);
  assert.equal(response.status, 401);
});

test("LLM proxy preserves the provider base path, strips capability headers, and attaches only the provider key", async () => {
  const token = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response("ok");
  };
  try {
    const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/llm/openai/openai-responses/responses?stream=true", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-codevil-proxy-target": "https://api.openai.com/v1",
        "x-codevil-internal": "kept",
        "x-codevil-debug": "must-not-reach-provider",
      },
      body: "{}",
    }), env);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses?stream=true");
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer real-provider-key");
    assert.equal(calls[0].init.headers.get("x-codevil-proxy-target"), null);
    assert.equal(calls[0].init.headers.get("x-codevil-proxy-token"), null);
    assert.equal(calls[0].init.headers.get("x-codevil-internal"), null);
    assert.equal(calls[0].init.headers.get("x-codevil-debug"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxy token parser rejects capabilities with missing or extra JWT-like segments", async () => {
  const token = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" });
  for (const malformed of [token.split(".").slice(1).join("."), `${token}.extra`]) {
    const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/llm/openai/openai-responses/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${malformed}`, "x-codevil-proxy-target": "https://api.openai.com/v1" },
    }), env);
    assert.equal(response.status, 401);
  }
});

test("malicious suffixes and target authorities never receive the provider key", async () => {
  const token = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response("unexpected");
  };
  try {
    for (const suffix of ["//evil.test", "/https://evil.test", "/%2F%2Fevil.test", "/\\\\evil.test", "/../evil.test"]) {
      const response = await handleSandboxProxy(new Request(`https://worker.test/sandbox-proxy/sessions/ses_s1/llm/openai/openai-responses${suffix}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-codevil-proxy-target": "https://api.openai.com/v1" },
      }), env);
      // URL parsing may normalize dot segments before routing; either rejection
      // is acceptable, but no malformed path may reach the credentialed fetch.
      assert.ok([400, 404].includes(response.status), `${suffix}: ${response.status}`);
    }
    for (const target of ["http://api.openai.com/v1", "https://user@api.openai.com/v1", "https://api.openai.com:444/v1", "https://api.openai.com/v1?x=1"]) {
      const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/llm/openai/openai-responses/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-codevil-proxy-target": target },
      }), env);
      assert.equal(response.status, 403, target);
    }
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capabilities are bound to their signed session and Pi API route", async () => {
  const token = await createSandboxProxyToken(secret, { sessionId: "ses_s1", provider: "openai", api: "openai-responses" });
  for (const path of [
    "/sandbox-proxy/sessions/ses_s2/llm/openai/openai-responses/responses",
    "/sandbox-proxy/sessions/ses_s1/llm/openai/openai-completions/chat/completions",
  ]) {
    const response = await handleSandboxProxy(new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-codevil-proxy-target": "https://api.openai.com/v1" },
    }), env);
    assert.equal(response.status, 401, path);
  }
});

test("Git proxy permits PAT-authenticated reads of any repository without exposing the PAT", async () => {
  const token = await createSandboxGitProxyToken(secret, { sessionId: "ses_s1", primaryRepo: "primary/app" });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return new Response("pack"); };
  try {
    const cap = Buffer.from(`x-access-token:${token}`).toString("base64");
    const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-upload-pack", {
      headers: { authorization: `Basic ${cap}`, "x-codevil-proxy-target": "https://evil.test" },
    }), env);
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://github.com/other/private.git/info/refs?service=git-upload-pack");
    assert.equal(calls[0].init.headers.get("authorization"), `Basic ${Buffer.from("x-access-token:real-github-pat").toString("base64")}`);
    assert.equal(JSON.stringify(calls[0]).includes(token), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Git proxy drops client control headers before its GitHub subrequest", async () => {
  const token = await createSandboxGitProxyToken(secret, { sessionId: "ses_s1", primaryRepo: "primary/app" });
  const cap = Buffer.from(`x-access-token:${token}`).toString("base64");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return new Response("pack"); };
  try {
    const response = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-upload-pack", {
      headers: {
        authorization: `Basic ${cap}`,
        connection: "keep-alive, x-hop-test, ()",
        "x-hop-test": "remove-me",
        "cache-control": "no-cache",
        origin: "https://sandbox.test",
        range: "bytes=0-10",
        "x-forwarded-for": "192.0.2.1",
        "cf-connecting-ip": "192.0.2.1",
        "cf-ipcountry": "IN",
        "git-protocol": "version=2",
      },
    }), env);

    assert.equal(response.status, 200);
    for (const header of ["connection", "x-hop-test", "cache-control", "origin", "range", "x-forwarded-for", "cf-connecting-ip", "cf-ipcountry"]) {
      assert.equal(calls[0].init.headers.get(header), null, header);
    }
    assert.equal(calls[0].init.headers.get("git-protocol"), "version=2");
  } finally { globalThis.fetch = originalFetch; }
});

test("Git proxy challenges unauthenticated smart-HTTP requests so Git can invoke its credential helper", async () => {
  const response = await handleSandboxProxy(new Request(
    "https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-upload-pack",
  ), env);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Basic realm="Codevil sandbox Git proxy"');
});

test("Git proxy canonicalizes the exact bare clone route to the .git upstream", async () => {
  const token = await createSandboxGitProxyToken(secret, { sessionId: "ses_s1", primaryRepo: "primary/app" });
  const cap = Buffer.from(`x-access-token:${token}`).toString("base64");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return new Response("pack"); };
  try {
    for (const repository of ["https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private", "https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private.git"]) {
      const response = await handleSandboxProxy(new Request(`${repository}/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Basic ${cap}` },
      }), env);
      assert.equal(response.status, 200, repository);
    }
    assert.deepEqual(calls.map((call) => call.url), [
      "https://github.com/other/private.git/info/refs?service=git-upload-pack",
      "https://github.com/other/private.git/info/refs?service=git-upload-pack",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Git proxy permits writes only to the signed primary repository and rejects suffix/authority attacks", async () => {
  const token = await createSandboxGitProxyToken(secret, { sessionId: "ses_s1", primaryRepo: "primary/app" });
  const cap = Buffer.from(`x-access-token:${token}`).toString("base64");
  const headers = { authorization: `Basic ${cap}` };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("ok"); };
  try {
    const allowed = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/github/primary/app.git/git-receive-pack", { method: "POST", headers }), env);
    assert.equal(allowed.status, 200);
    const other = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private.git/git-receive-pack", { method: "POST", headers }), env);
    assert.equal(other.status, 403);
    for (const path of ["/sandbox-proxy/sessions/ses_s1/github/primary/app.git//evil", "/sandbox-proxy/sessions/ses_s1/github/primary/app.git/%2F%2Fevil"]) {
      const response = await handleSandboxProxy(new Request(`https://worker.test${path}`, { headers }), env);
      assert.ok([400, 404].includes(response.status));
    }
    for (const path of ["/sandbox-proxy/sessions/ses_s1/github/primary/app/objects/aa/bb", "/sandbox-proxy/sessions/ses_s1/github/primary/app/extra/info/refs?service=git-upload-pack"]) {
      const response = await handleSandboxProxy(new Request(`https://worker.test${path}`, { headers }), env);
      assert.ok([400, 404].includes(response.status), path);
    }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Git proxy exposes only the smart-HTTP read and primary-repository write endpoints", async () => {
  const token = await createSandboxGitProxyToken(secret, { sessionId: "ses_s1", primaryRepo: "primary/app" });
  const cap = Buffer.from(`x-access-token:${token}`).toString("base64");
  const headers = { authorization: `Basic ${cap}` };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return new Response("unexpected"); };
  try {
    const rejected = [
      ["GET", "/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-upload-pack&extra=1"],
      ["GET", "/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-upload-pack&service=git-upload-pack"],
      ["POST", "/sandbox-proxy/sessions/ses_s1/github/other/private.git/git-upload-pack?service=git-upload-pack"],
      ["GET", "/sandbox-proxy/sessions/ses_s1/github/other/private.git/git-upload-pack"],
      ["POST", "/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-upload-pack"],
      ["POST", "/sandbox-proxy/sessions/ses_s1/github/primary/app.git/git-receive-pack?extra=1"],
      ["DELETE", "/sandbox-proxy/sessions/ses_s1/github/primary/app.git/git-receive-pack"],
      ["POST", "/sandbox-proxy/sessions/ses_s1/github/primary/app.git/objects/aa/bb"],
    ];
    for (const [method, path] of rejected) {
      const response = await handleSandboxProxy(new Request(`https://worker.test${path}`, { method, headers }), env);
      assert.equal(response.status, 400, `${method} ${path}`);
    }
    assert.equal(calls.length, 0);

    const foreignReceiveAdvertisement = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/github/other/private.git/info/refs?service=git-receive-pack", { headers }), env);
    assert.equal(foreignReceiveAdvertisement.status, 403);
    assert.equal(calls.length, 0);

    const receiveAdvertisement = await handleSandboxProxy(new Request("https://worker.test/sandbox-proxy/sessions/ses_s1/github/primary/app.git/info/refs?service=git-receive-pack", { headers }), env);
    assert.equal(receiveAdvertisement.status, 200);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
