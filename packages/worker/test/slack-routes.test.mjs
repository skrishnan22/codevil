import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSlackCommand,
  handleSlackEvent,
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


test("command invalid signature returns 401", async () => {
  const response = await handleSlackCommand(
    new Request("https://codevil.example.com/slack/commands", {
      method: "POST",
      body: "team_id=T123&channel_id=C123&text=repo",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    }),
    { SLACK_SIGNING_SECRET: "secret", DB: fakeD1() },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid signature" });
});

test("event url_verification returns the Slack challenge", async () => {
  const body = JSON.stringify({
    type: "url_verification",
    challenge: "challenge-token",
  });

  const response = await handleSlackEvent(await signedSlackJsonRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    DB: fakeD1(),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);
  assert.equal(await response.text(), "challenge-token");
});

test("event invalid signature returns 401", async () => {
  const response = await handleSlackEvent(
    new Request("https://codevil.example.com/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "abc" }),
      headers: {
        "content-type": "application/json",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    }),
    { SLACK_SIGNING_SECRET: "secret", DB: fakeD1() },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid signature" });
});

test("event ignores app mentions when bot user id is missing", async () => {
  const db = fakeD1();
  const body = JSON.stringify({
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T123",
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      ts: "171951.0001",
      text: "<@U999> hello",
    },
  });

  const response = await handleSlackEvent(await signedSlackJsonRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    DB: db,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(db.records.length, 0);
});

test("event ignores app mentions when the text does not contain the configured bot mention", async () => {
  const db = fakeD1();
  const body = JSON.stringify({
    type: "event_callback",
    event_id: "Ev1b",
    team_id: "T123",
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      ts: "171951.0001",
      text: "hello there",
    },
  });

  const response = await handleSlackEvent(await signedSlackJsonRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    CODEVIL_SLACK_BOT_USER_ID: "U999",
    DB: db,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(db.records.length, 0);
});

test("event creates a session, links the Slack thread, and submits the stripped mention", async () => {
  const db = fakeD1({
    firstRows: [
      { default_repo_url: "https://github.com/acme/default" },
      null,
    ],
    runResults: [
      { meta: { changes: 1 } },
      { success: true },
      { success: true },
      { success: true },
      { success: true },
    ],
  });
  const orchestratorCalls = [];
  const postCalls = [];
  const createSessionCalls = [];
  const body = JSON.stringify({
    type: "event_callback",
    event_id: "Ev2",
    team_id: "T123",
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      ts: "171951.0002",
      text: "<@U999> please check this repo https://github.com/acme/repo",
    },
  });

  const response = await handleSlackEvent(await signedSlackJsonRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    CODEVIL_SLACK_BOT_USER_ID: "U999",
    DB: db,
    ORCHESTRATOR: fakeOrchestrator((sessionId) => ({
      async submitAgentRequest(args) {
        orchestratorCalls.push({ sessionId, args });
        return { ok: true };
      },
    })),
  }, {
    slackApi: async (token, method, payload) => {
      postCalls.push({ token, method, payload });
      return { ok: true, data: { ok: true } };
    },
    createSession: async (_env, requestUrl, input, actor) => {
      createSessionCalls.push({ requestUrl, input, actor });
      return {
        session_id: "ses_new",
        ws_url: "https://codevil.example.com/sessions/ses_new/ws",
        summary: { id: "ses_new", title: "acme/repo", repo: "https://github.com/acme/repo" },
      };
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(createSessionCalls, [{
    requestUrl: "https://codevil.example.com/slack/events",
    input: { repo: "https://github.com/acme/repo" },
    actor: { id: "external:slack:U123", name: "U123" },
  }]);
  assert.deepEqual(orchestratorCalls, [{
    sessionId: "ses_new",
    args: {
      text: "please check this repo https://github.com/acme/repo",
      actor: { id: "external:slack:U123", name: "U123" },
      planFirst: true,
    },
  }]);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].method, "chat.postMessage");
  assert.equal(postCalls[0].payload.channel, "C123");
  assert.equal(postCalls[0].payload.thread_ts, "171951.0002");
  assert.match(postCalls[0].payload.text, /Started Codevil session ses_new/);
  assert.match(db.records[0].sql, /^INSERT OR IGNORE INTO external_message_dedupe/i);
  assert.match(db.records[1].sql, /^INSERT INTO integrations/i);
  assert.match(db.records[2].sql, /^INSERT INTO integration_external_actors/i);
  assert.match(db.records[3].sql, /^SELECT \* FROM integration_channels/i);
  assert.match(db.records[4].sql, /^SELECT \* FROM external_session_links/i);
  assert.match(db.records[5].sql, /^INSERT INTO external_session_links/i);
  assert.deepEqual(db.records[5].bindings.slice(1, 7), [
    "int_slack_T123",
    "C123",
    "171951.0002",
    "ses_new",
    "171951.0002",
    "U123",
  ]);
});

test("event continues an existing linked session and updates the handled message id", async () => {
  const db = fakeD1({
    firstRows: [
      { default_repo_url: "https://github.com/acme/default" },
      {
        id: "esl_int_slack_T123_C123_171951.0001",
        integration_id: "int_slack_T123",
        external_channel_id: "C123",
        external_conversation_id: "171951.0001",
        session_id: "ses_existing",
      },
    ],
    runResults: [
      { meta: { changes: 1 } },
      { success: true },
      { success: true },
      { success: true },
    ],
  });
  const orchestratorCalls = [];
  const postCalls = [];
  const body = JSON.stringify({
    type: "event_callback",
    event_id: "Ev3",
    team_id: "T123",
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      ts: "171951.0003",
      thread_ts: "171951.0001",
      text: "<@U999> follow up",
    },
  });

  const response = await handleSlackEvent(await signedSlackJsonRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    CODEVIL_SLACK_BOT_USER_ID: "U999",
    DB: db,
    ORCHESTRATOR: fakeOrchestrator((sessionId) => ({
      async submitAgentRequest(args) {
        orchestratorCalls.push({ sessionId, args });
        return { ok: true };
      },
    })),
  }, {
    slackApi: async (token, method, payload) => {
      postCalls.push({ token, method, payload });
      return { ok: true, data: { ok: true } };
    },
    createSession: async () => {
      throw new Error("should not create a new session");
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(orchestratorCalls, [{
    sessionId: "ses_existing",
    args: {
      text: "follow up",
      actor: { id: "external:slack:U123", name: "U123" },
      planFirst: true,
    },
  }]);
  assert.equal(postCalls.length, 1);
  assert.match(postCalls[0].payload.text, /Continuing Codevil session ses_existing/);
  assert.match(db.records[5].sql, /^UPDATE external_session_links/i);
  assert.deepEqual(db.records[5].bindings, [
    "171951.0003",
    db.records[5].bindings[1],
    "esl_int_slack_T123_C123_171951.0001",
  ]);
});

test("command set-repo invalid URL returns usage text", async () => {
  const body = "team_id=T123&team_domain=acme&channel_id=C123&channel_name=eng&text=set-repo+nope";
  const response = await handleSlackCommand(await signedSlackRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    DB: fakeD1(),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);
  assert.match(await response.text(), /Usage:\n\/codevil set-repo https:\/\/github\.com\/org\/repo/);
});

test("command set-repo prepares integration and channel upsert statements", async () => {
  const db = fakeD1();
  const body = "team_id=T123&team_domain=acme&channel_id=C123&channel_name=eng&text=set-repo+https%3A%2F%2Fgithub.com%2Facme%2Fapp.git";
  const response = await handleSlackCommand(await signedSlackRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    CODEVIL_SLACK_BOT_USER_ID: "U999",
    DB: db,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Set Codevil default repo for this channel to https://github.com/acme/app.");
  assert.equal(db.records.length, 2);
  assert.match(db.records[0].sql, /^INSERT INTO integrations/i);
  assert.deepEqual(db.records[0].bindings.slice(0, 6), [
    "int_slack_T123",
    "slack",
    "T123",
    "acme",
    "U999",
    "{}",
  ]);
  assert.match(db.records[1].sql, /^INSERT INTO integration_channels/i);
  assert.equal(db.records[1].bindings[0], "ich_int_slack_T123_C123");
  assert.equal(db.records[1].bindings[4], "https://github.com/acme/app");
});

test("command repo no default returns no default text", async () => {
  const db = fakeD1({ firstRows: [null] });
  const body = "team_id=T123&team_domain=acme&channel_id=C123&channel_name=eng&text=repo";
  const response = await handleSlackCommand(await signedSlackRequest(body), {
    SLACK_SIGNING_SECRET: "secret",
    DB: db,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "This channel does not have a Codevil default repo.");
  assert.match(db.records[1].sql, /SELECT \* FROM integration_channels/i);
});

test("command repo returns saved default and clear-repo prepares clear update", async () => {
  const db = fakeD1({ firstRows: [{ default_repo_url: "https://github.com/acme/app" }] });
  const repoBody = "team_id=T123&team_domain=acme&channel_id=C123&channel_name=eng&text=repo";
  const repoResponse = await handleSlackCommand(await signedSlackRequest(repoBody), {
    SLACK_SIGNING_SECRET: "secret",
    DB: db,
  });

  assert.equal(await repoResponse.text(), "This channel default repo is https://github.com/acme/app.");

  const clearBody = "team_id=T123&team_domain=acme&channel_id=C123&channel_name=eng&text=clear-repo";
  const clearResponse = await handleSlackCommand(await signedSlackRequest(clearBody), {
    SLACK_SIGNING_SECRET: "secret",
    DB: db,
  });

  assert.equal(clearResponse.status, 200);
  assert.equal(await clearResponse.text(), "Cleared the Codevil default repo for this channel.");
  assert.match(db.records[3].sql, /UPDATE integration_channels/);
  assert.match(db.records[3].sql, /SET default_repo_url = NULL/);
  assert.deepEqual(db.records[3].bindings.slice(1), ["int_slack_T123", "C123"]);
});

async function signedSlackRequest(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex("secret", `v0:${timestamp}:${body}`)}`;
  return new Request("https://codevil.example.com/slack/commands", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
  });
}

async function signedSlackJsonRequest(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex("secret", `v0:${timestamp}:${body}`)}`;
  return new Request("https://codevil.example.com/slack/events", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
  });
}

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

function fakeD1({ firstRows = [], runResults = [] } = {}) {
  const records = [];
  return {
    records,
    prepare(sql) {
      const record = { sql, bindings: [] };
      records.push(record);
      return {
        bind(...bindings) {
          record.bindings = bindings;
          return {
            run: async () => runResults.shift() ?? { success: true },
            first: async () => firstRows.shift() ?? null,
          };
        },
      };
    },
  };
}

function fakeOrchestrator(buildStub) {
  return {
    idFromName: (name) => name,
    get: (id) => buildStub(id),
  };
}
