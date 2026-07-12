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

test("dispatchHttpRequest protects Slack setup routes with admin-ish auth", async () => {
  let corsApplied = false;
  const response = await dispatchHttpRequest(
    new Request("https://codevil.example.workers.dev/integrations/slack/status"),
    {
      ORCHESTRATOR: {
        idFromName: (name) => name,
        get: () => {
          throw new Error("should not route to preview");
        },
      },
    },
    {
      withCors: (_request, _env, innerResponse) => {
        corsApplied = true;
        return innerResponse;
      },
    },
  );

  assert.equal(corsApplied, true);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Auth is not configured" });
});


test("dispatchHttpRequest routes Slack slash commands before origin guard", async () => {
  const body = new URLSearchParams({
    team_id: "T123",
    channel_id: "C123",
    channel_name: "eng",
    text: "repo",
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex("secret", `v0:${timestamp}:${body}`)}`;

  const response = await dispatchHttpRequest(new Request("https://codevil.example.workers.dev/slack/commands", {
    method: "POST",
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  }), {
    SLACK_SIGNING_SECRET: "secret",
    DB: createFakeIntegrationDb(),
    ORCHESTRATOR: {
      idFromName: (name) => name,
      get: () => {
        throw new Error("should not route to preview");
      },
    },
  }, {
    withCors: (_request, _env, innerResponse) => innerResponse,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "This channel does not have a Codevil default repo.");
});

test("dispatchHttpRequest routes Slack events before origin guard", async () => {
  const body = JSON.stringify({
    type: "url_verification",
    challenge: "challenge-token",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex("secret", `v0:${timestamp}:${body}`)}`;

  const response = await dispatchHttpRequest(new Request("https://codevil.example.workers.dev/slack/events", {
    method: "POST",
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  }), {
    SLACK_SIGNING_SECRET: "secret",
    DB: createFakeIntegrationDb(),
    ORCHESTRATOR: {
      idFromName: (name) => name,
      get: () => {
        throw new Error("should not route to preview");
      },
    },
  }, {
    withCors: (_request, _env, innerResponse) => innerResponse,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "challenge-token");
});

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createFakeIntegrationDb() {
  const channels = new Map();
  return {
    prepare(sql) {
      const state = { bindings: [] };
      return {
        bind(...bindings) {
          state.bindings = bindings;
          return this;
        },
        async run() {
          return { success: true };
        },
        async first() {
          if (/SELECT \* FROM integration_channels/i.test(sql)) {
            const [integrationId, channelId] = state.bindings;
            return channels.get(`${integrationId}:${channelId}`) ?? null;
          }
          return null;
        },
      };
    },
  };
}
