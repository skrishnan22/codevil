import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgentDriver, extractAssistantDeltaFromEvent, extractAssistantTextFromEvent, consolidationPrompt } from "../dist/pi-driver.js";

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

test("starts with coding tools, create_pull_request, and ask_question active", async () => {
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
      askQuestion: async () => ({
        cancelled: false,
        option_ids: ["opt_1"],
        answered_by: { id: "usr_1", name: "Alice" },
      }),
    });

    const session = driver.session;
    assert.deepEqual(session.getActiveToolNames().sort(), [
      "ask_question",
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
    assert.ok(session.getAllTools().some((tool) => tool.name === "ask_question"));
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

// --- consolidationPrompt (new prose-brief model) ---

test("consolidationPrompt instructs the agent to output prose (not JSON)", () => {
  const prompt = consolidationPrompt({
    cwd: "/tmp/repo",
    run_id: "run_1",
    round: 0,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    plan: "## Plan\n1. Build the thing",
    annotations: [
      { id: "ann_1", anchoredQuote: "Build", sourceLine: 1, authorName: "Alice", comment: "Use D1", replies: [] },
    ],
  });
  // Must tell the agent to emit prose, not JSON
  assert.ok(prompt.includes("plain prose") || prompt.includes("message text"), `prompt should mention prose output, got:\n${prompt}`);
  // Must NOT say "Return ONLY valid JSON" (old model)
  assert.ok(!prompt.includes("Return ONLY valid JSON"), "prompt must not instruct JSON output");
  // Must include the plan content
  assert.ok(prompt.includes("## Plan"), "prompt must include the plan markdown");
  // Must include annotations
  assert.ok(prompt.includes("ann_1"), "prompt must include annotation id");
  assert.ok(prompt.includes("Use D1"), "prompt must include annotation comment text");
});

test("consolidationPrompt instructs use of ask_question on contradictions", () => {
  const prompt = consolidationPrompt({
    cwd: "/tmp/repo",
    run_id: "run_2",
    round: 1,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    plan: "## Plan",
    annotations: [
      { id: "ann_a", anchoredQuote: "storage", sourceLine: 2, authorName: "Bob", comment: "Use Redis", replies: [] },
      { id: "ann_b", anchoredQuote: "storage", sourceLine: 2, authorName: "Carol", comment: "Avoid Redis", replies: [] },
    ],
  });
  // Must mention ask_question tool
  assert.ok(prompt.includes("ask_question"), "prompt must instruct use of the ask_question tool on contradictions");
  // Must not instruct the agent to pick a side
  assert.ok(!prompt.includes("do not choose — emit a conflict"), "old conflict-emit instruction must not appear");
});

test("consolidationPrompt includes both annotations in the prompt body", () => {
  const ann1 = { id: "ann_x", anchoredQuote: "cache", sourceLine: 5, authorName: "Dave", comment: "Use Memcached", replies: [] };
  const ann2 = { id: "ann_y", anchoredQuote: "cache", sourceLine: 5, authorName: "Eve", comment: "Use Redis", replies: [] };
  const prompt = consolidationPrompt({
    cwd: "/tmp/repo",
    run_id: "run_3",
    round: 0,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    plan: "# My Plan",
    annotations: [ann1, ann2],
  });
  assert.ok(prompt.includes("ann_x"), "prompt must include ann_x id");
  assert.ok(prompt.includes("ann_y"), "prompt must include ann_y id");
  assert.ok(prompt.includes("Memcached"), "prompt must include ann_x comment");
  assert.ok(prompt.includes("Redis"), "prompt must include ann_y comment");
});
