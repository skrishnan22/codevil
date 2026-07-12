import assert from "node:assert/strict";
import test from "node:test";

import { externalNotificationIntent } from "../dist/integrations/notification-intents.js";
import { notifyExternalConversation } from "../dist/integrations/notify-external-conversation.js";

test("externalNotificationIntent maps curated Agent Run milestones", () => {
  assert.deepEqual(externalNotificationIntent({
    type: "agent_run_started",
    run_id: "run_1",
    actor: { id: "U1", name: "Ada" },
    text: "Fix auth",
  }), { type: "run_started", runId: "run_1" });

  assert.deepEqual(externalNotificationIntent({
    type: "approval_requested",
    run_id: "run_1",
    plan: "Plan",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0 },
    refinement_round: 0,
  }), { type: "approval_requested", runId: "run_1" });

  assert.deepEqual(externalNotificationIntent({
    type: "question_raised",
    request_id: "question_1",
    run_id: "run_1",
    question: "Which database?",
    allow_freeform: true,
    allow_multiple: false,
    answerable_by: "anyone",
    status: "open",
    raised_at: "2026-07-12T00:00:00.000Z",
  }), { type: "question_asked", runId: "run_1", question: "Which database?" });

  assert.deepEqual(externalNotificationIntent({
    type: "agent_run_completed",
    run_id: "run_1",
    pr_url: "https://github.com/acme/app/pull/7",
  }), {
    type: "run_completed",
    runId: "run_1",
    pullRequestUrl: "https://github.com/acme/app/pull/7",
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
    { type: "agent_response", run_id: "run_1", text: "Done" },
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
      type: "agent_run_started",
      run_id: "run_1",
      actor: { id: "U1", name: "Ada" },
      text: "Fix auth",
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
      text: "Codevil started working. Open session: https://codevil.example/sessions/ses_123",
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
