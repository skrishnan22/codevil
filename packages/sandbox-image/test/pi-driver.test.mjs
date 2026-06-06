import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgentDriver, extractAssistantDeltaFromEvent, extractAssistantTextFromEvent } from "../dist/pi-driver.js";

test("extracts plan text from Pi agent_end messages", () => {
  const text = extractAssistantTextFromEvent({
    type: "agent_end",
    messages: [
      { role: "user", content: "make a plan" },
      { role: "assistant", content: [{ type: "text", text: "## Plan\n\n1. Fix UI" }] },
    ],
  });

  assert.equal(text, "## Plan\n\n1. Fix UI");
});

test("extracts plan text from Pi turn_end message", () => {
  const text = extractAssistantTextFromEvent({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text: "## Revised Plan" }] },
  });

  assert.equal(text, "## Revised Plan");
});

test("extracts streamed assistant text from Pi message_update deltas", () => {
  const text = extractAssistantDeltaFromEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "## Plan\n" },
  });

  assert.equal(text, "## Plan\n");
});

test("starts with coding tools and the create_pull_request tool active", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-driver-"));
  const driver = new PiAgentDriver();
  const createPullRequestCalls = [];

  try {
    await driver.start({
      cwd,
      mode: "coding",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      llmKey: "test-key",
      onEvent: () => {},
      createPullRequest: async (options) => {
        createPullRequestCalls.push(options);
        return { url: "https://github.com/example/app/pull/1" };
      },
    });

    const session = driver.session;
    assert.deepEqual(session.getActiveToolNames().sort(), [
      "bash",
      "create_pull_request",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    assert.ok(session.getAllTools().some((tool) => tool.name === "create_pull_request"));
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
