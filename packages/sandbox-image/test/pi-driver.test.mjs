import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgentDriver, extractAssistantDeltaFromEvent, extractAssistantTextFromEvent, normalizeBriefItems, normalizeConflicts, parseConsolidationResult } from "../dist/pi-driver.js";

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

// --- Consolidation robustness tests (eval-style) ---

test("normalizeBriefItems: plain string array becomes valid BriefItem objects (the reported bug)", () => {
  const raw = ["Skip the deletion for now", "Use D1 storage"];
  const result = normalizeBriefItems(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].instruction, "Skip the deletion for now");
  assert.deepEqual(result[0].source_thread_ids, []);
  assert.equal(result[1].instruction, "Use D1 storage");
  assert.deepEqual(result[1].source_thread_ids, []);
});

test("normalizeBriefItems: objects missing source_thread_ids default to []", () => {
  const raw = [{ instruction: "Add caching layer" }];
  const result = normalizeBriefItems(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].instruction, "Add caching layer");
  assert.deepEqual(result[0].source_thread_ids, []);
});

test("normalizeBriefItems: mixed strings and objects; empty instructions dropped", () => {
  const raw = [
    "Plain string instruction",
    { instruction: "Object instruction", source_thread_ids: ["ann_1", "ann_2"] },
    { instruction: "   ", source_thread_ids: [] },
    "",
    { text: "Fallback text key", source_thread_ids: ["ann_3"] },
    null,
    42,
  ];
  const result = normalizeBriefItems(raw);
  assert.equal(result.length, 3);
  assert.equal(result[0].instruction, "Plain string instruction");
  assert.deepEqual(result[0].source_thread_ids, []);
  assert.equal(result[1].instruction, "Object instruction");
  assert.deepEqual(result[1].source_thread_ids, ["ann_1", "ann_2"]);
  assert.equal(result[2].instruction, "Fallback text key");
  assert.deepEqual(result[2].source_thread_ids, ["ann_3"]);
});

test("normalizeConflicts: synthesizes valid AnnotationConflict from LLM summary+options", () => {
  const raw = [
    {
      summary: "Team disagrees on storage approach",
      options: [
        { thread_id: "ann_1", gist: "Use D1" },
        { thread_id: "ann_2", gist: "Use KV" },
      ],
    },
  ];
  const result = normalizeConflicts(raw, "run_abc", 1);
  assert.equal(result.length, 1);
  const conflict = result[0];
  assert.ok(conflict.id.startsWith("conf_"), `id should start with conf_, got: ${conflict.id}`);
  assert.equal(conflict.run_id, "run_abc");
  assert.equal(conflict.round, 1);
  assert.equal(conflict.status, "open");
  assert.equal(conflict.summary, "Team disagrees on storage approach");
  assert.equal(conflict.options.length, 2);
  assert.equal(conflict.options[0].thread_id, "ann_1");
  assert.equal(conflict.options[0].gist, "Use D1");
});

test("normalizeConflicts: conflict with fewer than 2 valid options is dropped", () => {
  const raw = [
    { summary: "Only one option", options: [{ thread_id: "ann_1", gist: "The only view" }] },
    { summary: "No options at all", options: [] },
    { summary: "Missing gist", options: [{ thread_id: "ann_1", gist: "" }, { thread_id: "ann_2", gist: "ok" }] },
  ];
  const result = normalizeConflicts(raw, "run_x", 0);
  // First: only 1 valid option → dropped
  // Second: 0 options → dropped
  // Third: first option has empty gist → only 1 valid → dropped
  assert.equal(result.length, 0);
});

test("parseConsolidationResult: brief_items as plain strings no longer throws (the exact reported bug)", () => {
  const json = JSON.stringify({
    brief_items: ["Skip the deletion for now", "Use D1 storage"],
    conflicts: [],
  });
  // Must not throw
  let result;
  assert.doesNotThrow(() => {
    result = parseConsolidationResult(json, "run_1", 0);
  });
  assert.equal(result.brief_items.length, 2);
  assert.equal(result.brief_items[0].instruction, "Skip the deletion for now");
  assert.deepEqual(result.brief_items[0].source_thread_ids, []);
});

test("parseConsolidationResult: full conflict with only summary+options is synthesized into valid AnnotationConflict", () => {
  const json = JSON.stringify({
    brief_items: [],
    conflicts: [
      {
        summary: "Storage engine disagreement",
        options: [
          { thread_id: "t_1", gist: "Use Postgres" },
          { thread_id: "t_2", gist: "Use SQLite" },
        ],
      },
    ],
  });
  const result = parseConsolidationResult(json, "run_42", 3);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict.id.startsWith("conf_"));
  assert.equal(conflict.run_id, "run_42");
  assert.equal(conflict.round, 3);
  assert.equal(conflict.status, "open");
  assert.equal(conflict.summary, "Storage engine disagreement");
});

test("parseConsolidationResult: non-JSON text throws clean 'did not return a JSON object' error", () => {
  assert.throws(
    () => parseConsolidationResult("Here is my thoughts on this plan, but no JSON."),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("did not return a JSON object"),
        `Expected clean error message but got: ${err.message}`,
      );
      return true;
    },
  );
});

test("parseConsolidationResult: JSON wrapped in markdown fences is parsed correctly", () => {
  const fenced = "Sure, here you go:\n```json\n" + JSON.stringify({
    brief_items: [{ instruction: "Refactor the auth module", source_thread_ids: ["ann_5"] }],
    conflicts: [],
  }) + "\n```\n";
  const result = parseConsolidationResult(fenced, "run_2", 1);
  assert.equal(result.brief_items.length, 1);
  assert.equal(result.brief_items[0].instruction, "Refactor the auth module");
  assert.deepEqual(result.brief_items[0].source_thread_ids, ["ann_5"]);
});
