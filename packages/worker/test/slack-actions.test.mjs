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
