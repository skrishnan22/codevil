import assert from "node:assert/strict";
import test from "node:test";

const questionAnswerModule = import("../dist/orchestrator/question-answer.js").catch(() => ({}));

async function answer(host, args) {
  const module = await questionAnswerModule;
  assert.equal(typeof module.answerQuestionFromIntegration, "function");
  return module.answerQuestionFromIntegration(host, args);
}

function question(overrides = {}) {
  return {
    request_id: "question_1",
    run_id: "run_1",
    question: "Which database?",
    status: "open",
    options_json: JSON.stringify([
      { id: "pg", label: "PostgreSQL" },
      { id: "sqlite", label: "SQLite" },
      { id: "mysql", label: "MySQL" },
    ]),
    allow_freeform: 0,
    allow_multiple: 0,
    answer_json: null,
    answered_by_id: null,
    answered_by_name: null,
    answered_at: null,
    answerable_by: "decider",
    assigned_to_id: null,
    assigned_to_name: null,
    ...overrides,
  };
}

function fixture(row = question(), options = {}) {
  const broadcasts = [];
  const sandboxMessages = [];
  const sandboxSockets = options.sandboxConnected === false ? [] : [{}];
  const host = {
    meta: { session_id: "ses_123", created_by: { id: "creator", name: "Creator" } },
    ctx: {
      getWebSockets(tag) {
        return tag === "sandbox" ? sandboxSockets : [];
      },
    },
    sql: {
      exec(sql, ...bindings) {
        if (sql.includes("SELECT") && sql.includes("FROM questions")) {
          return row && row.request_id === bindings[0] ? [{ ...row }] : [];
        }
        if (sql.includes("UPDATE questions") && sql.includes("SET status = 'answered'")) {
          const [answerJson, answeredById, answeredByName, answeredAt, requestId] = bindings;
          if (row && row.request_id === requestId && row.status === "open") {
            row.status = "answered";
            row.answer_json = answerJson;
            row.answered_by_id = answeredById;
            row.answered_by_name = answeredByName;
            row.answered_at = answeredAt;
          }
          return [];
        }
        return [];
      },
    },
    appendAndBroadcast(event) { broadcasts.push(event); },
    sendToSandbox(message) { sandboxMessages.push(message); },
  };
  return { host, row, broadcasts, sandboxMessages };
}

const slackActor = { id: "external:slack:U123", name: "krish" };

test("Slack option ordinals map to stored option IDs", async () => {
  const state = fixture();
  const result = await answer(state.host, {
    requestId: "question_1",
    optionIndexes: [0],
    actor: slackActor,
  });

  assert.deepEqual(result, {
    ok: true,
    status: "answered",
    question: "Which database?",
    selectedLabels: ["PostgreSQL"],
    answeredBy: slackActor,
  });
  assert.equal(state.row.status, "answered");
  assert.equal(state.broadcasts.filter((event) => event.type === "question_answered").length, 1);
  assert.deepEqual(state.sandboxMessages, [{
    type: "ask_question_response",
    request_id: "question_1",
    option_ids: ["pg"],
    answered_by: slackActor,
  }]);
});

test("Slack answer validation rejects invalid ordinals and cardinality", async () => {
  for (const optionIndexes of [[-1], [9], [0, 1], [1.5]]) {
    const state = fixture();
    const result = await answer(state.host, {
      requestId: "question_1",
      optionIndexes,
      actor: slackActor,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid_selection");
    assert.equal(state.row.status, "open");
    assert.equal(state.broadcasts.length, 0);
  }
});

test("Slack answer fails without consuming the question when the sandbox is unavailable", async () => {
  const state = fixture(question(), { sandboxConnected: false });
  const result = await answer(state.host, {
    requestId: "question_1",
    optionIndexes: [0],
    actor: slackActor,
  });

  assert.deepEqual(result, {
    ok: false,
    status: "sandbox_unavailable",
    error: "Sandbox is reconnecting. Please try again in a moment.",
  });
  assert.equal(state.row.status, "open");
  assert.equal(state.broadcasts.length, 0);
  assert.equal(state.sandboxMessages.length, 0);
});

test("the first accepted answer wins and retries return persisted state", async () => {
  const state = fixture();
  const first = await answer(state.host, {
    requestId: "question_1",
    optionIndexes: [1],
    actor: slackActor,
  });
  const second = await answer(state.host, {
    requestId: "question_1",
    optionIndexes: [0],
    actor: { id: "external:slack:U456", name: "Ada" },
  });

  assert.equal(first.status, "answered");
  assert.deepEqual(second, {
    ok: true,
    status: "already_answered",
    question: "Which database?",
    selectedLabels: ["SQLite"],
    answeredBy: slackActor,
  });
  assert.equal(state.broadcasts.filter((event) => event.type === "question_answered").length, 1);
  assert.equal(state.sandboxMessages.length, 1);
});

test("missing and cancelled questions are not answerable", async () => {
  for (const row of [null, question({ status: "cancelled" })]) {
    const state = fixture(row);
    const result = await answer(state.host, {
      requestId: "question_1",
      optionIndexes: [0],
      actor: slackActor,
    });
    assert.equal(result.ok, false);
    assert.ok(["not_found", "not_open"].includes(result.status));
  }
});

test("Slack integration answers intentionally allow any human for every web answer policy", async () => {
  for (const answerableBy of ["anyone", "decider", "assigned"]) {
    const state = fixture(question({
      answerable_by: answerableBy,
      assigned_to_id: answerableBy === "assigned" ? "web-user" : null,
      assigned_to_name: answerableBy === "assigned" ? "Web User" : null,
    }));
    const result = await answer(state.host, {
      requestId: "question_1",
      optionIndexes: [0],
      actor: slackActor,
    });

    assert.equal(result.ok, true, `Slack actor should answer ${answerableBy} questions`);
    assert.equal(result.status, "answered");
  }
});
