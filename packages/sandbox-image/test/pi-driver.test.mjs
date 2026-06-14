import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgentDriver, extractAssistantDeltaFromEvent, extractAssistantTextFromEvent, normalizeBriefItems, normalizeConflicts, parseConsolidationResult, consolidationPrompt } from "../dist/pi-driver.js";

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

test("parseConsolidationResult: brace-wrapped but malformed JSON throws clean 'did not return valid JSON' error", () => {
  assert.throws(
    () => parseConsolidationResult("{ not valid json }"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("did not return valid JSON"),
        `Expected clean error message but got: ${err.message}`,
      );
      // Must NOT be a raw SyntaxError
      assert.notEqual(err.constructor.name, "SyntaxError");
      return true;
    },
  );
});

test("parseConsolidationResult: malformed conflicts are dropped and valid ones survive", () => {
  const json = JSON.stringify({
    brief_items: [{ instruction: "Keep this", source_thread_ids: [] }],
    conflicts: [
      // Valid conflict
      {
        summary: "Real disagreement",
        options: [
          { thread_id: "t_1", gist: "Option A" },
          { thread_id: "t_2", gist: "Option B" },
        ],
      },
      // Malformed: only 1 option — will be dropped
      {
        summary: "Only one side",
        options: [{ thread_id: "t_3", gist: "Lonely view" }],
      },
      // Malformed: empty summary — will be dropped
      {
        summary: "",
        options: [
          { thread_id: "t_4", gist: "A" },
          { thread_id: "t_5", gist: "B" },
        ],
      },
    ],
  });
  let result;
  assert.doesNotThrow(() => {
    result = parseConsolidationResult(json, "run_drop", 2);
  });
  assert.equal(result.brief_items.length, 1);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].summary, "Real disagreement");
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
    conflicts: [],
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
    conflicts: [],
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
    conflicts: [],
  });
  assert.ok(prompt.includes("ann_x"), "prompt must include ann_x id");
  assert.ok(prompt.includes("ann_y"), "prompt must include ann_y id");
  assert.ok(prompt.includes("Memcached"), "prompt must include ann_x comment");
  assert.ok(prompt.includes("Redis"), "prompt must include ann_y comment");
});
