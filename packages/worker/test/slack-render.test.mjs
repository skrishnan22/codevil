import assert from "node:assert/strict";
import test from "node:test";

import * as slackRender from "../dist/integrations/slack/render.js";

const {
  renderSlackFreeformAnswerModal,
  renderSlackNotification,
  renderSlackRunCard,
} = slackRender;

const sessionUrl = "https://codevil.example/sessions/ses_123";

test("renderSlackRunCard keeps validated sources clickable in rich text", () => {
  const rendered = renderSlackRunCard({
    runId: "run_1",
    title: "Ship",
    status: "complete",
    phase: "Complete",
    summary: "Completed successfully.",
    steps: [],
    droppedSteps: 0,
    prUrl: "https://github.com/acme/app/pull/12",
  }, sessionUrl, 1);

  assert.deepEqual(rendered.blocks[0].child_blocks.at(-1).elements[0].elements, [
    { type: "link", url: sessionUrl, text: "Open Codevil" },
    { type: "text", text: " · " },
    { type: "link", url: "https://github.com/acme/app/pull/12", text: "View pull request" },
  ]);
});

test("renderSlackNotification renders conversational messages", () => {
  assert.deepEqual(
    renderSlackNotification({
      type: "agent_response",
      runId: "run_1",
      text: "## Summary\n\n**What changed:** see [the diff](https://github.com/acme/app/commit/abc).\n\n- Updated `apps/web`",
    }, sessionUrl),
    [{
      text: "Summary What changed: see the diff. Updated apps/web",
      blocks: [{
        type: "markdown",
        text: "## Summary\n\n**What changed:** see [the diff](https://github.com/acme/app/commit/abc).\n\n- Updated `apps/web`",
      }],
    }],
  );
  assert.equal(
    renderSlackNotification({
      type: "question_asked",
      requestId: "question_1",
      runId: "run_1",
      question: "Which database should I use?",
      allowFreeform: true,
      allowMultiple: false,
    }, sessionUrl)[0].text,
    `Codevil needs input: Which database should I use? Open session: ${sessionUrl}`,
  );
  assert.deepEqual(
    renderSlackNotification({
      type: "approval_requested",
      runId: "run_1",
      plan: "Update the auth flow.",
    }, sessionUrl),
    [{ text: `Codevil needs plan approval:\n\nUpdate the auth flow.\n\nOpen session: ${sessionUrl}` }],
  );
});

function questionIntent(overrides = {}) {
  return {
    type: "question_asked",
    requestId: "question_1",
    runId: "run_1",
    question: "Which database?",
    options: [
      { id: "pg", label: "PostgreSQL", detail: "Managed production database" },
      { id: "sqlite", label: "SQLite" },
    ],
    allowFreeform: false,
    allowMultiple: false,
    ...overrides,
  };
}

test("single-choice questions use direct answer buttons", () => {
  const [message] = renderSlackNotification(questionIntent(), sessionUrl);
  assert.equal(message.blocks[0].type, "markdown");
  assert.doesNotMatch(message.blocks[0].text, /PostgreSQL/);
  const actions = message.blocks.find((block) => block.type === "actions");
  assert.deepEqual(actions.elements.map((element) => element.type), ["button", "button", "button"]);
  assert.deepEqual(actions.elements.slice(0, 2).map((element) => element.action_id), [
    "codevil_question_answer_0",
    "codevil_question_answer_1",
  ]);
  assert.equal(new Set(actions.elements.map((element) => element.action_id)).size, actions.elements.length);
  assert.deepEqual(actions.elements.slice(0, 2).map((element) => JSON.parse(element.value)), [
    { v: 1, q: "question_1", i: 0 },
    { v: 1, q: "question_1", i: 1 },
  ]);
  assert.equal(actions.elements[2].url, sessionUrl);
});

test("larger single-choice questions use a select and submit button", () => {
  const options = Array.from({ length: 6 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` }));
  const [message] = renderSlackNotification(questionIntent({ options }), sessionUrl);
  const actions = message.blocks.find((block) => block.type === "actions");
  assert.deepEqual(actions.elements.map((element) => element.type), ["static_select", "button", "button"]);
  assert.deepEqual(actions.elements[0].options.map((option) => option.value), ["0", "1", "2", "3", "4", "5"]);
  assert.equal(actions.elements[1].action_id, "codevil_question_submit");
});

test("multiple-choice questions use checkboxes through ten options", () => {
  const [message] = renderSlackNotification(questionIntent({ allowMultiple: true }), sessionUrl);
  const actions = message.blocks.find((block) => block.type === "actions");
  assert.deepEqual(actions.elements.map((element) => element.type), ["checkboxes", "button", "button"]);
  assert.equal(actions.elements[1].action_id, "codevil_question_submit");
  assert.equal(JSON.stringify(message.blocks).match(/PostgreSQL/g)?.length, 1);
  assert.equal(JSON.stringify(message.blocks).match(/Managed production database/g)?.length, 1);
});

test("multiple-choice questions use a multi-select above ten options", () => {
  const options = Array.from({ length: 11 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` }));
  const [message] = renderSlackNotification(questionIntent({ options, allowMultiple: true }), sessionUrl);
  const actions = message.blocks.find((block) => block.type === "actions");
  assert.deepEqual(actions.elements.map((element) => element.type), ["multi_static_select", "button", "button"]);
});

test("unrepresentable questions fall back to Open session", () => {
  for (const intent of [
    questionIntent({ options: Array.from({ length: 101 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` })) }),
    questionIntent({ options: undefined }),
  ]) {
    const [message] = renderSlackNotification(intent, sessionUrl);
    const actions = message.blocks.find((block) => block.type === "actions");
    assert.deepEqual(actions.elements.map((element) => element.type), ["button"]);
    assert.equal(actions.elements[0].url, sessionUrl);
  }
  const [unrepresentable] = renderSlackNotification(questionIntent({
    options: Array.from({ length: 101 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` })),
  }), sessionUrl);
  assert.match(unrepresentable.blocks[0].text, /Option 0/);
});

test("free-form questions show a primary Write answer action while option-only questions do not", () => {
  const [freeformQuestion] = renderSlackNotification(questionIntent({ allowFreeform: true }), sessionUrl);
  const freeformActions = freeformQuestion.blocks.find((block) => block.type === "actions");
  const write = freeformActions.elements.find((element) => element.action_id === "codevil_question_open_freeform");
  assert.equal(write.text.text, "Write answer");
  assert.equal(write.style, "primary");
  assert.deepEqual(JSON.parse(write.value), { v: 1, q: "question_1" });

  const [optionOnlyQuestion] = renderSlackNotification(questionIntent(), sessionUrl);
  const optionOnlyActions = optionOnlyQuestion.blocks.find((block) => block.type === "actions");
  assert.equal(optionOnlyActions.elements.some((element) => element.action_id === "codevil_question_open_freeform"), false);
});

test("renderSlackFreeformAnswerModal bounds display text and renders one required multiline input", () => {
  const privateMetadata = JSON.stringify({ v: 1, q: "question_1", t: "T123", c: "C123", th: "171951.0001", m: "171951.0002" });
  const modal = renderSlackFreeformAnswerModal({
    question: "Q".repeat(1_050),
    context: "C".repeat(1_050),
    privateMetadata,
  });

  assert.equal(modal.type, "modal");
  assert.equal(modal.callback_id, "codevil_question_freeform");
  assert.equal(modal.private_metadata, privateMetadata);
  assert.equal(modal.blocks[0].text.text, `*Question*\n${"Q".repeat(999)}…`);
  assert.equal(modal.blocks[1].text.text, `*Context*\n${"C".repeat(999)}…`);
  assert.deepEqual(modal.blocks[2], {
    type: "input",
    block_id: "codevil_question_freeform_input",
    label: { type: "plain_text", text: "Answer", emoji: true },
    element: {
      type: "plain_text_input",
      action_id: "codevil_question_freeform_value",
      multiline: true,
    },
  });
});

test("answered questions remove controls and mention the Slack answerer", () => {
  assert.equal(typeof slackRender.renderAnsweredSlackQuestion, "function");
  const message = slackRender.renderAnsweredSlackQuestion({
    question: "Which database?",
    selectedLabels: ["PostgreSQL"],
    answeredByText: "<@U123>",
  });
  assert.doesNotMatch(JSON.stringify(message.blocks), /Codevil question answered/);
  assert.match(JSON.stringify(message.blocks), /✓ PostgreSQL/);
  assert.match(JSON.stringify(message.blocks), /Answered by <@U123>/);
  assert.equal(message.blocks.some((block) => block.type === "actions"), false);
  assert.doesNotMatch(JSON.stringify(message.blocks), /codevil_open_session/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /codevil_question_answer/);
});

test("renderSlackNotification preserves tables and emphasized GitHub URLs for Slack", () => {
  const markdown = [
    "## Runtime",
    "",
    "| Spec | Value |",
    "| --- | --- |",
    "| Pull request | *https://github.com/acme/app/pull/45* |",
  ].join("\n");

  assert.deepEqual(
    renderSlackNotification({ type: "agent_response", runId: "run_1", text: markdown }, sessionUrl),
    [{
      text: "Runtime Spec: Value; Pull request: https://github.com/acme/app/pull/45",
      blocks: [{ type: "markdown", text: markdown }],
    }],
  );
});

test("renderSlackNotification bounds external text", () => {
  const rendered = renderSlackNotification({
    type: "run_failed",
    runId: "run_1",
    message: "x".repeat(2_000),
  }, sessionUrl);

  assert.ok(rendered[0].text.length < 700);
  assert.match(rendered[0].text, /^Codevil could not complete the Agent Run: x+/);
  assert.match(rendered[0].text, /Open session:/);
});

test("renderSlackNotification preserves longer agent responses", () => {
  const rendered = renderSlackNotification({
    type: "agent_response",
    runId: "run_1",
    text: "x".repeat(5_000),
  }, sessionUrl);

  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].blocks[0].text.length, 5_000);
});

test("renderSlackNotification splits long fenced code without breaking fences", () => {
  const markdown = [
    "# Generated source",
    "",
    "```ts",
    ...Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};`),
    "```",
  ].join("\n");

  const rendered = renderSlackNotification({
    type: "agent_response",
    runId: "run_1",
    text: markdown,
  }, sessionUrl);

  assert.ok(rendered.length > 1);
  for (const message of rendered) {
    assert.ok(message.blocks[0].text.length <= 11_500);
    assert.equal((message.blocks[0].text.match(/```/g) ?? []).length % 2, 0);
  }
  assert.match(rendered[1].blocks[0].text, /^```ts\n/);
  assert.match(rendered.at(-1).blocks[0].text, /const value999 = 999;/);
});
