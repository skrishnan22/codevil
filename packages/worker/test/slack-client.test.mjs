import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlackWebApi,
  fetchSlackThreadReplies,
  postSlackMessage,
} from "../dist/integrations/slack/client.js";

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
    data: null,
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
