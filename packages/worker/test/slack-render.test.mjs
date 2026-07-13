import assert from "node:assert/strict";
import test from "node:test";

import { renderSlackNotification } from "../dist/integrations/slack/render.js";

const sessionUrl = "https://codevil.example/sessions/ses_123";

test("renderSlackNotification renders conversational messages", () => {
  assert.equal(
    renderSlackNotification({
      type: "agent_response",
      runId: "run_1",
      text: "## Summary\n\n**What changed:** see [the diff](https://github.com/acme/app/commit/abc).\n\n- Updated `apps/web`",
    }, sessionUrl),
    "*Summary*\n\n*What changed:* see <https://github.com/acme/app/commit/abc|the diff>.\n\n• Updated `apps/web`",
  );
  assert.equal(
    renderSlackNotification({
      type: "question_asked",
      runId: "run_1",
      question: "Which database should I use?",
    }, sessionUrl),
    `Codevil needs input: Which database should I use? Open session: ${sessionUrl}`,
  );
  assert.equal(
    renderSlackNotification({
      type: "approval_requested",
      runId: "run_1",
      plan: "Update the auth flow.",
    }, sessionUrl),
    `Codevil needs plan approval:\n\nUpdate the auth flow.\n\nOpen session: ${sessionUrl}`,
  );
});

test("renderSlackNotification bounds external text", () => {
  const rendered = renderSlackNotification({
    type: "run_failed",
    runId: "run_1",
    message: "x".repeat(2_000),
  }, sessionUrl);

  assert.ok(rendered.length < 700);
  assert.match(rendered, /^Codevil could not complete the Agent Run: x+/);
  assert.match(rendered, /Open session:/);
});

test("renderSlackNotification preserves longer agent responses", () => {
  const rendered = renderSlackNotification({
    type: "agent_response",
    runId: "run_1",
    text: "x".repeat(5_000),
  }, sessionUrl);

  assert.equal(rendered.length, 5_000);
});
