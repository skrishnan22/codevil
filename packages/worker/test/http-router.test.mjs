import assert from "node:assert/strict";
import test from "node:test";

import { dispatchHttpRequest } from "../dist/http-router.js";

test("dispatchHttpRequest routes escaped preview requests by same-origin preview referer", async () => {
  let captured = null;
  const env = {
    ORCHESTRATOR: {
      idFromName: (name) => name,
      get: (id) => ({
        fetchPreview: (request, token) => {
          captured = { id, token, url: request.url };
          return new Response("proxied");
        },
      }),
    },
  };

  const request = new Request("https://codevil.example.workers.dev/@vite/client", {
    headers: {
      referer: "https://codevil.example.workers.dev/sessions/ses_abc/preview/ses-abc-deadbeef/",
    },
  });

  const response = await dispatchHttpRequest(request, env, {
    withCors: (_request, _env, innerResponse) => innerResponse,
  });

  assert.equal(await response.text(), "proxied");
  assert.deepEqual(captured, {
    id: "ses_abc",
    token: "ses-abc-deadbeef",
    url: "https://codevil.example.workers.dev/sessions/ses_abc/preview/ses-abc-deadbeef/@vite/client",
  });
});

test("dispatchHttpRequest ignores preview-looking referers from another origin", async () => {
  const env = {
    ORCHESTRATOR: {
      idFromName: (name) => name,
      get: () => {
        throw new Error("should not route to preview");
      },
    },
  };

  const request = new Request("https://codevil.example.workers.dev/@vite/client", {
    headers: {
      referer: "https://evil.example.com/sessions/ses_abc/preview/ses-abc-deadbeef/",
    },
  });

  const response = await dispatchHttpRequest(request, env, {
    withCors: (_request, _env, innerResponse) => innerResponse,
  });

  assert.equal(response, null);
});

test("dispatchHttpRequest forwards sandbox WebSocket capabilities without the deployment API key", async () => {
  let forwarded = null;
  const env = {
    ORCHESTRATOR: {
      idFromName: (name) => `do:${name}`,
      get: (id) => ({
        fetch: (request) => {
          forwarded = { id, url: request.url, upgrade: request.headers.get("Upgrade") };
          return new Response("forwarded");
        },
      }),
    },
  };
  const request = new Request(
    "https://codevil.example.workers.dev/sessions/ses_abc/sandbox/ws?sandbox_ws_token=session-bound-capability",
    { headers: { Upgrade: "websocket" } },
  );

  const response = await dispatchHttpRequest(request, env, {
    withCors: (_request, _env, innerResponse) => innerResponse,
  });

  assert.equal(await response.text(), "forwarded");
  assert.deepEqual(forwarded, {
    id: "do:ses_abc",
    url: request.url,
    upgrade: "websocket",
  });
});

test("dispatchHttpRequest still requires the deployment API key for logs", async () => {
  const env = {
    CODEVIL_API_KEY: "deployment-key",
    ORCHESTRATOR: {},
  };
  const request = new Request("https://codevil.example.workers.dev/sessions/ses_abc/logs");

  const response = await dispatchHttpRequest(request, env, {
    withCors: (_request, _env, innerResponse) => innerResponse,
  });

  assert.equal(response.status, 401);
});
