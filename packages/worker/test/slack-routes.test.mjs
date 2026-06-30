import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSlackManifest,
  handleSlackStatus,
} from "../dist/integrations/slack/routes.js";

test("manifest route returns YAML with request origin", async () => {
  const response = await handleSlackManifest(
    new Request("https://codevil.example.com/integrations/slack/manifest"),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/yaml/);
  const body = await response.text();
  assert.match(body, /url: https:\/\/codevil\.example\.com\/slack\/commands/);
  assert.match(body, /request_url: https:\/\/codevil\.example\.com\/slack\/events/);
});

test("status reports missing Slack configuration without checking Slack API", async () => {
  let called = false;
  const response = await handleSlackStatus({}, {
    slackApi: async () => {
      called = true;
      return { ok: true, data: { ok: true } };
    },
  });

  assert.equal(response.status, 200);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), {
    configured: false,
    env: {
      botToken: false,
      signingSecret: false,
      botUserId: false,
    },
    missing: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  });
});

test("status checks auth.test through injected Slack API when bot token exists", async () => {
  const calls = [];
  const response = await handleSlackStatus({
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "secret",
    CODEVIL_SLACK_BOT_USER_ID: "U999",
  }, {
    slackApi: async (token, method, body) => {
      calls.push({ token, method, body });
      return {
        ok: true,
        data: {
          ok: true,
          team: "Acme",
          team_id: "T123",
          user_id: "U999",
        },
      };
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ token: "xoxb-test", method: "auth.test", body: undefined }]);
  assert.deepEqual(await response.json(), {
    configured: true,
    env: {
      botToken: true,
      signingSecret: true,
      botUserId: true,
    },
    missing: [],
    authTest: {
      ok: true,
      team: "Acme",
      team_id: "T123",
      user_id: "U999",
    },
  });
});

test("status reports injected Slack API auth.test failures", async () => {
  const response = await handleSlackStatus({
    SLACK_BOT_TOKEN: "xoxb-test",
  }, {
    slackApi: async () => ({ ok: false, error: "invalid_auth" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: false,
    env: {
      botToken: true,
      signingSecret: false,
      botUserId: false,
    },
    missing: ["SLACK_SIGNING_SECRET"],
    authTest: {
      ok: false,
      error: "invalid_auth",
    },
  });
});
