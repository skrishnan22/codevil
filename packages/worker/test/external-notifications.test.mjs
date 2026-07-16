import assert from "node:assert/strict";
import test from "node:test";

import { externalNotificationIntent } from "../dist/integrations/notification-intents.js";
import { notifyExternalConversation } from "../dist/integrations/notify-external-conversation.js";

test("externalNotificationIntent maps conversational Agent Run events", () => {
  assert.deepEqual(externalNotificationIntent({
    type: "agent_response",
    run_id: "run_1",
    text: "I updated the README.",
  }), { type: "agent_response", runId: "run_1", text: "I updated the README." });

  assert.deepEqual(externalNotificationIntent({
    type: "approval_requested",
    run_id: "run_1",
    plan: "Plan",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0 },
    refinement_round: 0,
  }), { type: "approval_requested", runId: "run_1", plan: "Plan" });

  assert.deepEqual(externalNotificationIntent({
    type: "question_raised",
    request_id: "question_1",
    run_id: "run_1",
    question: "Which database?",
    context: "Choose the deployment store.",
    options: [
      { id: "pg", label: "PostgreSQL", detail: "Managed production database" },
      { id: "sqlite", label: "SQLite" },
    ],
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
    status: "open",
    raised_at: "2026-07-12T00:00:00.000Z",
  }), {
    type: "question_asked",
    requestId: "question_1",
    runId: "run_1",
    question: "Which database?",
    context: "Choose the deployment store.",
    options: [
      { id: "pg", label: "PostgreSQL", detail: "Managed production database" },
      { id: "sqlite", label: "SQLite" },
    ],
    allowFreeform: false,
    allowMultiple: false,
  });

  assert.deepEqual(externalNotificationIntent({
    type: "agent_run_failed",
    run_id: "run_1",
    message: "Tests failed",
  }), { type: "run_failed", runId: "run_1", message: "Tests failed" });
});

test("externalNotificationIntent ignores noisy events", () => {
  for (const event of [
    { type: "status", message: "Cloning" },
    { type: "clone_progress", line: "Receiving objects" },
    { type: "agent_event", event: { type: "tool_execution_start" } },
    { type: "agent_run_started", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth" },
    { type: "agent_run_completed", run_id: "run_1" },
  ]) {
    assert.equal(externalNotificationIntent(event), null);
  }
});

test("notifyExternalConversation skips unmapped events without database work", async () => {
  const db = fakeD1();

  await notifyExternalConversation({
    env: { DB: db },
    sessionId: "ses_123",
    workerOrigin: "https://codevil.example",
    cursor: 12,
    event: { type: "status", message: "Cloning" },
  });

  assert.equal(db.records.length, 0);
});

test("notifyExternalConversation posts mapped events to the linked Slack thread", async () => {
  const db = fakeD1({
    firstRows: [{
      provider: "slack",
      integration_id: "int_slack_T123",
      external_channel_id: "C123",
      external_conversation_id: "171951.0001",
    }],
    runResults: [{ meta: { changes: 1 } }],
  });
  const calls = [];

  await notifyExternalConversation({
    env: { DB: db, SLACK_BOT_TOKEN: "xoxb-test" },
    sessionId: "ses_123",
    workerOrigin: "https://codevil.example/",
    cursor: 12,
    event: {
      type: "agent_response",
      run_id: "run_1",
      text: "I fixed the auth flow.",
    },
  }, {
    slackApi: async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, data: { ok: true } };
    },
  });

  assert.match(db.records[0].sql, /external_session_links/);
  assert.match(db.records[0].sql, /JOIN integrations/);
  assert.match(db.records[1].sql, /^INSERT OR IGNORE INTO external_message_dedupe/);
  assert.deepEqual(calls, [{
    token: "xoxb-test",
    method: "chat.postMessage",
    body: {
      channel: "C123",
      thread_ts: "171951.0001",
      text: "I fixed the auth flow.",
      blocks: [{ type: "markdown", text: "I fixed the auth flow." }],
    },
  }]);
});

test("notifyExternalConversation suppresses a duplicate durable cursor", async () => {
  const db = fakeD1({
    firstRows: [{
      provider: "slack",
      integration_id: "int_slack_T123",
      external_channel_id: "C123",
      external_conversation_id: "171951.0001",
    }],
    runResults: [{ meta: { changes: 0 } }],
  });
  let posted = false;

  await notifyExternalConversation({
    env: { DB: db, SLACK_BOT_TOKEN: "xoxb-test" },
    sessionId: "ses_123",
    workerOrigin: "https://codevil.example",
    cursor: 12,
    event: { type: "agent_run_completed", run_id: "run_1" },
  }, {
    slackApi: async () => {
      posted = true;
      return { ok: true, data: { ok: true } };
    },
  });

  assert.equal(posted, false);
});

test("notifyExternalConversation retries a transient Slack failure in place", async () => {
  const db = fakeD1({
    firstRows: [{
      provider: "slack",
      integration_id: "int_slack_T123",
      external_channel_id: "C123",
      external_conversation_id: "171951.0001",
    }],
    runResults: [{ meta: { changes: 1 } }],
  });
  const attempts = [];
  const delays = [];

  await notifyExternalConversation({
    env: { DB: db, SLACK_BOT_TOKEN: "xoxb-test" },
    sessionId: "ses_123",
    workerOrigin: "https://codevil.example",
    cursor: 14,
    event: {
      type: "question_raised",
      request_id: "question_3",
      run_id: "run_1",
      question: "Which deployment region?",
      options: [{ id: "iad", label: "US East" }],
      allow_freeform: false,
      allow_multiple: false,
      answerable_by: "decider",
      status: "open",
      raised_at: "2026-07-16T00:00:00.000Z",
    },
  }, {
    slackApi: async () => {
      attempts.push(Date.now());
      return attempts.length === 1
        ? { ok: false, error: "ratelimited", status: 429, retryAfterMs: 3_000 }
        : { ok: true, data: { ok: true, ts: "171951.0003" } };
    },
    sleep: async (delayMs) => { delays.push(delayMs); },
    random: () => 0,
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(delays, [3_000]);
  assert.equal(db.records.filter((record) => /^INSERT OR IGNORE INTO external_message_dedupe/.test(record.sql)).length, 1);
  assert.equal(db.records.some((record) => /^DELETE FROM external_message_dedupe/.test(record.sql)), false);
});

test("notifyExternalConversation releases its claim after transient retries are exhausted", async () => {
  const db = fakeD1({
    firstRows: [{
      provider: "slack",
      integration_id: "int_slack_T123",
      external_channel_id: "C123",
      external_conversation_id: "171951.0001",
    }],
    runResults: [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
  });
  let attempts = 0;
  const delays = [];

  await notifyExternalConversation(questionNotificationInput({ db, cursor: 15 }), {
    slackApi: async () => {
      attempts += 1;
      return { ok: false, error: "http_503", status: 503 };
    },
    sleep: async (delayMs) => { delays.push(delayMs); },
    random: () => 0,
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1_000]);
  const release = db.records.find((record) => /^DELETE FROM external_message_dedupe/.test(record.sql));
  assert.deepEqual(release?.bindings, ["int_slack_T123", "outbound:ses_123:15"]);
});

test("notifyExternalConversation does not retry permanent Slack failures", async () => {
  const db = fakeD1({
    firstRows: [{
      provider: "slack",
      integration_id: "int_slack_T123",
      external_channel_id: "C123",
      external_conversation_id: "171951.0001",
    }],
    runResults: [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
  });
  let attempts = 0;

  await notifyExternalConversation(questionNotificationInput({ db, cursor: 16 }), {
    slackApi: async () => {
      attempts += 1;
      return { ok: false, error: "invalid_auth" };
    },
    sleep: async () => { throw new Error("permanent errors must not sleep"); },
  });

  assert.equal(attempts, 1);
  assert.equal(db.records.some((record) => /^DELETE FROM external_message_dedupe/.test(record.sql)), true);
});

test("notifyExternalConversation posts every long response chunk in order", async () => {
  const db = fakeD1({
    firstRows: [{
      provider: "slack",
      integration_id: "int_slack_T123",
      external_channel_id: "C123",
      external_conversation_id: "171951.0001",
    }],
    runResults: [{ meta: { changes: 1 } }],
  });
  const calls = [];
  const text = `FIRST\n${"x".repeat(11_000)}\n${"y".repeat(11_000)}\nLAST`;

  await notifyExternalConversation({
    env: { DB: db, SLACK_BOT_TOKEN: "xoxb-test" },
    sessionId: "ses_123",
    workerOrigin: "https://codevil.example",
    cursor: 13,
    event: { type: "agent_response", run_id: "run_1", text },
  }, {
    slackApi: async (_token, method, body) => {
      calls.push({ method, body });
      return { ok: true, data: { ok: true, ts: `171951.000${calls.length + 1}` } };
    },
  });

  assert.ok(calls.length > 1);
  assert.ok(calls.every((call) => call.method === "chat.postMessage"));
  assert.ok(calls.every((call) => call.body.channel === "C123"));
  assert.ok(calls.every((call) => call.body.thread_ts === "171951.0001"));
  assert.match(calls[0].body.blocks[0].text, /^FIRST/);
  assert.match(calls.at(-1).body.blocks[0].text, /LAST$/);
});

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
            first: async () => firstRows.shift() ?? null,
            run: async () => runResults.shift() ?? { success: true },
          };
        },
      };
    },
  };
}

function questionNotificationInput({ db, cursor }) {
  return {
    env: { DB: db, SLACK_BOT_TOKEN: "xoxb-test" },
    sessionId: "ses_123",
    workerOrigin: "https://codevil.example",
    cursor,
    event: {
      type: "question_raised",
      request_id: `question_${cursor}`,
      run_id: "run_1",
      question: "Which deployment region?",
      options: [{ id: "iad", label: "US East" }],
      allow_freeform: false,
      allow_multiple: false,
      answerable_by: "decider",
      status: "open",
      raised_at: "2026-07-16T00:00:00.000Z",
    },
  };
}
