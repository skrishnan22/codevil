import assert from "node:assert/strict";
import test from "node:test";

import { renderSlackNotification } from "../dist/integrations/slack/render.js";

const sessionUrl = "https://codevil.example/sessions/ses_123";

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
  assert.deepEqual(
    renderSlackNotification({
      type: "question_asked",
      runId: "run_1",
      question: "Which database should I use?",
    }, sessionUrl),
    [{ text: `Codevil needs input: Which database should I use? Open session: ${sessionUrl}` }],
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
