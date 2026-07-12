import assert from "node:assert/strict";
import test from "node:test";

import { renderSlackNotification } from "../dist/integrations/slack/render.js";

const sessionUrl = "https://codevil.example/sessions/ses_123";

test("renderSlackNotification renders concise lifecycle milestones", () => {
  assert.equal(
    renderSlackNotification({ type: "run_started", runId: "run_1" }, sessionUrl),
    `Codevil started working. Open session: ${sessionUrl}`,
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
      type: "run_completed",
      runId: "run_1",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
    }, sessionUrl),
    `Codevil finished the Agent Run. Pull request: https://github.com/acme/app/pull/7 Open session: ${sessionUrl}`,
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
