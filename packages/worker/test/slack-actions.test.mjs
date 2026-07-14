import assert from "node:assert/strict";
import test from "node:test";

const actionsModule = import("../dist/integrations/slack/actions.js").catch(() => ({}));

async function parse(payload) {
  const module = await actionsModule;
  assert.equal(typeof module.parseSlackQuestionAction, "function");
  return module.parseSlackQuestionAction(payload);
}

function basePayload(overrides = {}) {
  return {
    type: "block_actions",
    team: { id: "T123" },
    user: { id: "U123" },
    channel: { id: "C123" },
    container: { type: "message", message_ts: "171951.0002", channel_id: "C123" },
    message: { ts: "171951.0002", thread_ts: "171951.0001" },
    actions: [{
      action_id: "codevil_question_answer",
      action_ts: "171951.1111",
      value: JSON.stringify({ v: 1, q: "question_1", i: 0 }),
    }],
    state: { values: {} },
    ...overrides,
  };
}

test("parseSlackQuestionAction parses a direct option button", async () => {
  assert.deepEqual(await parse(basePayload()), {
    teamId: "T123",
    userId: "U123",
    channelId: "C123",
    messageTs: "171951.0002",
    threadTs: "171951.0001",
    requestId: "question_1",
    optionIndexes: [0],
    actionTs: "171951.1111",
  });
});

test("parseSlackQuestionAction reads selected values from block state", async () => {
  for (const selection of [
    { type: "static_select", selected_option: { value: "2" } },
    { type: "checkboxes", selected_options: [{ value: "2" }, { value: "0" }, { value: "2" }] },
    { type: "multi_static_select", selected_options: [{ value: "3" }, { value: "1" }] },
  ]) {
    const payload = basePayload({
      actions: [{
        action_id: "codevil_question_submit",
        action_ts: "171951.1111",
        value: JSON.stringify({ v: 1, q: "question_1" }),
      }],
      state: {
        values: {
          controls: { codevil_question_select: selection },
        },
      },
    });
    const parsed = await parse(payload);
    const expected = selection.selected_option ? [2] : selection.type === "checkboxes" ? [0, 2] : [1, 3];
    assert.deepEqual(parsed.optionIndexes, expected);
  }
});

test("parseSlackQuestionAction rejects malformed or unsafe actions", async () => {
  for (const payload of [
    basePayload({ team: {} }),
    basePayload({ actions: [] }),
    basePayload({ actions: [{ action_id: "unknown", action_ts: "1", value: "{}" }] }),
    basePayload({ actions: [{ action_id: "codevil_question_answer", action_ts: "1", value: "not-json" }] }),
    basePayload({ actions: [{ action_id: "codevil_question_answer", action_ts: "1", value: JSON.stringify({ v: 1, q: "q", i: -1 }) }] }),
    basePayload({ actions: [{ action_id: "codevil_question_answer", action_ts: "1", value: JSON.stringify({ v: 1, q: "q", i: 1.5 }) }] }),
  ]) {
    assert.equal(await parse(payload), null);
  }
});

test("isSlackQuestionSelectionAction recognizes non-submitting selection changes", async () => {
  const module = await actionsModule;
  assert.equal(typeof module.isSlackQuestionSelectionAction, "function");
  assert.equal(module.isSlackQuestionSelectionAction(basePayload({
    actions: [{ action_id: "codevil_question_select", action_ts: "171951.1111" }],
  })), true);
  assert.equal(module.isSlackQuestionSelectionAction(basePayload()), false);
});

function parsedAction(overrides = {}) {
  return {
    teamId: "T123",
    userId: "U123",
    channelId: "C123",
    messageTs: "171951.0002",
    threadTs: "171951.0001",
    requestId: "question_1",
    optionIndexes: [0],
    actionTs: "171951.1111",
    ...overrides,
  };
}

function actionFixture({
  answerStatus = "answered",
  profile = "krish",
  profileFailure = false,
  profileFlags = {},
  linkExists = true,
  answerFailure = null,
} = {}) {
  const records = [];
  const slackCalls = [];
  const orchestratorCalls = [];
  const link = {
    id: "esl_1",
    integration_id: "int_slack_T123",
    external_channel_id: "C123",
    external_conversation_id: "171951.0001",
    session_id: "ses_123",
  };
  const env = {
    SLACK_BOT_TOKEN: "xoxb-test",
    CODEVIL_SLACK_BOT_USER_ID: "U999",
    DB: {
      prepare(sql) {
        const record = { sql, bindings: [] };
        records.push(record);
        return {
          bind(...bindings) {
            record.bindings = bindings;
            return {
              first: async () => linkExists ? link : null,
              run: async () => ({ success: true, meta: { changes: 1 } }),
            };
          },
        };
      },
    },
    ORCHESTRATOR: {
      idFromName: (name) => name,
      get: (sessionId) => ({
        answerQuestionFromIntegration(args) {
          orchestratorCalls.push({ sessionId, args });
          if (answerFailure instanceof Error) throw answerFailure;
          if (answerFailure) return { ok: false, error: answerFailure };
          return {
            ok: true,
            status: answerStatus,
            question: "Which database?",
            selectedLabels: ["PostgreSQL"],
            answeredBy: answerStatus === "answered"
              ? args.actor
              : { id: "external:slack:U456", name: "Ada" },
          };
        },
      }),
    },
  };
  const slackApi = async (_token, method, body) => {
    slackCalls.push({ method, body });
    if (method === "users.info") {
      if (profileFailure) return { ok: false, error: "user_not_found" };
      return {
        ok: true,
        data: {
          ok: true,
          user: {
            id: "U123",
            name: "legacy-name",
            real_name: "Krish Dev",
            profile: { display_name: profile },
            is_bot: false,
            is_app_user: false,
            ...profileFlags,
          },
        },
      };
    }
    return { ok: true, data: { ok: true } };
  };
  return { env, slackApi, records, slackCalls, orchestratorCalls };
}

test("processSlackQuestionAction attributes and reflects an accepted answer", async () => {
  const module = await actionsModule;
  assert.equal(typeof module.processSlackQuestionAction, "function");
  const fixture = actionFixture();

  await module.processSlackQuestionAction(parsedAction(), fixture.env, {
    slackApi: fixture.slackApi,
    workerOrigin: "https://codevil.example",
  });

  assert.equal(fixture.orchestratorCalls.length, 1);
  assert.deepEqual(fixture.orchestratorCalls[0], {
    sessionId: "ses_123",
    args: {
      requestId: "question_1",
      optionIndexes: [0],
      actor: { id: "external:slack:U123", name: "krish" },
      idempotencyKey: "T123:U123:C123:171951.0002:171951.1111:question_1",
    },
  });
  assert.ok(fixture.records.some((record) => /INSERT INTO integration_external_actors/.test(record.sql)));
  const update = fixture.slackCalls.find((call) => call.method === "chat.update");
  assert.ok(update);
  assert.match(JSON.stringify(update.body.blocks), /Answered by <@U123>/);
});

test("processSlackQuestionAction falls back to the Slack ID when profile lookup fails", async () => {
  const module = await actionsModule;
  assert.equal(typeof module.processSlackQuestionAction, "function");
  const fixture = actionFixture({ profileFailure: true });
  await module.processSlackQuestionAction(parsedAction(), fixture.env, {
    slackApi: fixture.slackApi,
    workerOrigin: "https://codevil.example",
  });
  assert.equal(fixture.orchestratorCalls[0].args.actor.name, "U123");
});

test("processSlackQuestionAction shows stale answers without overwriting them", async () => {
  const module = await actionsModule;
  assert.equal(typeof module.processSlackQuestionAction, "function");
  const fixture = actionFixture({ answerStatus: "already_answered" });
  await module.processSlackQuestionAction(parsedAction(), fixture.env, {
    slackApi: fixture.slackApi,
    workerOrigin: "https://codevil.example",
  });
  const update = fixture.slackCalls.find((call) => call.method === "chat.update");
  assert.match(JSON.stringify(update.body.blocks), /Answered by <@U456>/);
  assert.ok(fixture.slackCalls.some((call) => call.method === "chat.postEphemeral"));
});

test("processSlackQuestionAction rejects bot actors before Session mutation", async () => {
  const module = await actionsModule;
  assert.equal(typeof module.processSlackQuestionAction, "function");
  const fixture = actionFixture();
  await module.processSlackQuestionAction(parsedAction({ userId: "U999" }), fixture.env, {
    slackApi: fixture.slackApi,
    workerOrigin: "https://codevil.example",
  });
  assert.equal(fixture.orchestratorCalls.length, 0);
});

test("processSlackQuestionAction rejects Slack bot and app users", async () => {
  const module = await actionsModule;
  for (const profileFlags of [{ is_bot: true }, { is_app_user: true }]) {
    const fixture = actionFixture({ profileFlags });
    await module.processSlackQuestionAction(parsedAction(), fixture.env, {
      slackApi: fixture.slackApi,
      workerOrigin: "https://codevil.example",
    });
    assert.equal(fixture.orchestratorCalls.length, 0);
    assert.equal(fixture.slackCalls.some((call) => call.method === "chat.update"), false);
  }
});

test("processSlackQuestionAction reports an unlinked Slack thread without mutating a session", async () => {
  const module = await actionsModule;
  const fixture = actionFixture({ linkExists: false });
  await module.processSlackQuestionAction(parsedAction(), fixture.env, {
    slackApi: fixture.slackApi,
    workerOrigin: "https://codevil.example",
  });
  assert.equal(fixture.orchestratorCalls.length, 0);
  assert.match(
    fixture.slackCalls.find((call) => call.method === "chat.postEphemeral").body.text,
    /not linked/,
  );
});

test("processSlackQuestionAction leaves controls intact when session submission fails", async () => {
  const module = await actionsModule;
  for (const answerFailure of ["Question no longer exists", new Error("session unavailable")]) {
    const fixture = actionFixture({ answerFailure });
    await module.processSlackQuestionAction(parsedAction(), fixture.env, {
      slackApi: fixture.slackApi,
      workerOrigin: "https://codevil.example",
    });
    assert.equal(fixture.slackCalls.some((call) => call.method === "chat.update"), false);
    assert.ok(fixture.slackCalls.some((call) => call.method === "chat.postEphemeral"));
  }
});
