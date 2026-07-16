import assert from "node:assert/strict";
import test from "node:test";

import * as slackClient from "../dist/integrations/slack/client.js";

const { createSlackWebApi, fetchSlackThreadReplies, postSlackMessage } = slackClient;

test("Slack Web API client posts JSON and returns ok data", async () => {
  const requests = [];
  const slackApi = createSlackWebApi(async (url, init) => {
    requests.push({ url, init });
    return Response.json({ ok: true, team_id: "T123" });
  });

  const result = await slackApi("xoxb-test", "auth.test");

  assert.deepEqual(result, { ok: true, data: { ok: true, team_id: "T123" } });
  assert.equal(requests[0].url, "https://slack.com/api/auth.test");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.authorization, "Bearer xoxb-test");
  assert.equal(requests[0].init.body, "{}");
});

test("Slack Web API client returns Slack error envelopes", async () => {
  const slackApi = createSlackWebApi(async () => Response.json({ ok: false, error: "invalid_auth" }));

  assert.deepEqual(await slackApi("xoxb-test", "auth.test"), {
    ok: false,
    error: "invalid_auth",
    data: { ok: false, error: "invalid_auth" },
  });
});

test("Slack Web API client converts non-JSON responses into safe failures", async () => {
  const slackApi = createSlackWebApi(async () => new Response("gateway unavailable", {
    status: 502,
    headers: { "content-type": "text/html" },
  }));

  assert.deepEqual(await slackApi("xoxb-test", "auth.test"), {
    ok: false,
    error: "http_502",
    status: 502,
    data: null,
  });
});

test("Slack Web API client preserves retry metadata from rate limits", async () => {
  const slackApi = createSlackWebApi(async () => Response.json(
    { ok: false, error: "ratelimited" },
    { status: 429, headers: { "retry-after": "3" } },
  ));

  assert.deepEqual(await slackApi("xoxb-test", "chat.postMessage"), {
    ok: false,
    error: "ratelimited",
    status: 429,
    retryAfterMs: 3_000,
    data: { ok: false, error: "ratelimited" },
  });
});

test("Slack Web API client converts network failures into retryable results", async () => {
  const slackApi = createSlackWebApi(async () => {
    throw new TypeError("fetch failed");
  });

  assert.deepEqual(await slackApi("xoxb-test", "chat.postMessage"), {
    ok: false,
    error: "network_error",
  });
});

test("Slack thread reads use form-encoded request arguments", async () => {
  const requests = [];
  const slackApi = createSlackWebApi(async (url, init) => {
    requests.push({ url, init });
    return Response.json({ ok: true, messages: [] });
  });

  await fetchSlackThreadReplies(slackApi, "xoxb-test", "C123", "171951.0001");

  assert.equal(requests[0].init.headers["content-type"], "application/x-www-form-urlencoded; charset=utf-8");
  assert.equal(requests[0].init.body, "channel=C123&ts=171951.0001&limit=100");
});

test("postSlackMessage uses chat.postMessage", async () => {
  const calls = [];
  const result = await postSlackMessage(
    async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, data: { ok: true, ts: "171951.0001" } };
    },
    "xoxb-test",
    { channel: "C123", text: "hello" },
  );

  assert.deepEqual(calls, [{
    token: "xoxb-test",
    method: "chat.postMessage",
    body: { channel: "C123", text: "hello" },
  }]);
  assert.deepEqual(result, { ok: true, data: { ok: true, ts: "171951.0001" } });
});

test("postSlackMessage supports injectable Slack API with thread timestamp", async () => {
  const calls = [];
  await postSlackMessage(
    async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, data: { ok: true } };
    },
    "xoxb-test",
    { channel: "C123", text: "hello", threadTs: "171951.0001" },
  );

  assert.deepEqual(calls, [{
    token: "xoxb-test",
    method: "chat.postMessage",
    body: { channel: "C123", text: "hello", thread_ts: "171951.0001" },
  }]);
});

test("postSlackMessage forwards Slack blocks", async () => {
  const calls = [];
  await postSlackMessage(
    async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, data: { ok: true, ts: "171951.0002" } };
    },
    "xoxb-test",
    {
      channel: "C123",
      text: "Result",
      blocks: [{ type: "markdown", text: "**Result**" }],
      threadTs: "171951.0001",
    },
  );

  assert.deepEqual(calls, [{
    token: "xoxb-test",
    method: "chat.postMessage",
    body: {
      channel: "C123",
      text: "Result",
      blocks: [{ type: "markdown", text: "**Result**" }],
      thread_ts: "171951.0001",
    },
  }]);
});

test("fetchSlackThreadReplies requests the Slack thread", async () => {
  const calls = [];
  const result = await fetchSlackThreadReplies(
    async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, data: { messages: [] } };
    },
    "xoxb-test",
    "C123",
    "171951.0001",
  );

  assert.deepEqual(calls, [{
    token: "xoxb-test",
    method: "conversations.replies",
    body: { channel: "C123", ts: "171951.0001", limit: 100 },
  }]);
  assert.deepEqual(result, { ok: true, data: { messages: [] } });
});

test("Slack client helpers update, notify, and resolve users", async () => {
  assert.equal(typeof slackClient.updateSlackMessage, "function");
  assert.equal(typeof slackClient.postSlackEphemeral, "function");
  assert.equal(typeof slackClient.fetchSlackUser, "function");
  const calls = [];
  const api = async (token, method, body) => {
    calls.push({ token, method, body });
    return { ok: true, data: { ok: true } };
  };

  await slackClient.updateSlackMessage(api, "xoxb-test", {
    channel: "C123",
    ts: "171951.0002",
    text: "Answered",
    blocks: [{ type: "markdown", text: "**Answered**" }],
  });
  await slackClient.postSlackEphemeral(api, "xoxb-test", {
    channel: "C123",
    user: "U123",
    text: "Already answered",
  });
  await slackClient.fetchSlackUser(api, "xoxb-test", "U123");

  assert.deepEqual(calls, [
    {
      token: "xoxb-test",
      method: "chat.update",
      body: {
        channel: "C123",
        ts: "171951.0002",
        text: "Answered",
        blocks: [{ type: "markdown", text: "**Answered**" }],
      },
    },
    {
      token: "xoxb-test",
      method: "chat.postEphemeral",
      body: { channel: "C123", user: "U123", text: "Already answered" },
    },
    {
      token: "xoxb-test",
      method: "users.info",
      body: { user: "U123" },
    },
  ]);
});
