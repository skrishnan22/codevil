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

test("starts read-only but can unlock execution tools later", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-driver-"));
  const driver = new PiAgentDriver();

  try {
    await driver.start({
      cwd,
      mode: "read-only",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      llmKey: "test-key",
      onEvent: () => {},
    });

    const session = driver.session;
    assert.deepEqual(session.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
    assert.ok(session.getAllTools().some((tool) => tool.name === "bash"));
    assert.ok(session.getAllTools().some((tool) => tool.name === "edit"));
    assert.ok(session.getAllTools().some((tool) => tool.name === "write"));

    await driver.switchToExecution("claude-3-5-haiku-20241022", "anthropic");

    assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "read", "write"]);
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
