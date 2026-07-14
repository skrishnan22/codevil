import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIToDOMessageSchema,
  SandboxToDOMessageSchema,
  DOToSandboxMessageSchema,
  DOToCLIEventSchema,
  PersistedDOToCLIEventSchema,
  PiAgentEventSchema,
  AnnotationAnchorSchema,
  AnnotationCreateMessageSchema,
  AnnotationCreatedEventSchema,
  AskQuestionRequestSchema,
  AskQuestionResponseSchema,
  AskQuestionCancelledSchema,
  parseInbound,
  setValidationDropSink,
} from "../dist/index.js";

function captureDrops(run) {
  const drops = [];
  const prev = (drop) => drops.push(drop);
  setValidationDropSink(prev);
  try {
    run();
  } finally {
    // Reset to default sink (just console.error). We can't easily restore the
    // module-internal default, so install a no-op for the remainder of the
    // process — other tests installing a capture sink will overwrite anyway.
    setValidationDropSink(() => {});
  }
  return drops;
}

test("CLI→DO: valid approve message parses", () => {
  const result = parseInbound(CLIToDOMessageSchema, { type: "approve" }, "cli_to_do");
  assert.deepEqual(result, { type: "approve" });
});

test("CLI→DO: refine_plan requires feedback string", () => {
  const drops = captureDrops(() => {
    const result = parseInbound(CLIToDOMessageSchema, { type: "refine_plan" }, "cli_to_do");
    assert.equal(result, null);
  });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].boundary, "cli_to_do");
  assert.equal(drops[0].raw_type, "refine_plan");
});

test("CLI→DO: unknown message type is dropped", () => {
  const drops = captureDrops(() => {
    const result = parseInbound(CLIToDOMessageSchema, { type: "garbage" }, "cli_to_do");
    assert.equal(result, null);
  });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].raw_type, "garbage");
});

test("Sandbox→DO: clone_progress parses", () => {
  const result = parseInbound(
    SandboxToDOMessageSchema,
    { type: "clone_progress", line: "Cloning into..." },
    "sandbox_to_do",
  );
  assert.equal(result?.type, "clone_progress");
});

test("Sandbox→DO: credential_request requires host", () => {
  const drops = captureDrops(() => {
    const result = parseInbound(
      SandboxToDOMessageSchema,
      { type: "credential_request", request_id: "r1", protocol: "https" },
      "sandbox_to_do",
    );
    assert.equal(result, null);
  });
  assert.equal(drops.length, 1);
});

test("DO→Sandbox: agent turn parses with optional provider", () => {
  const result = parseInbound(
    DOToSandboxMessageSchema,
    { type: "agent_turn", run_id: "run_1", prompt: "do x", model: "claude-sonnet-4-6" },
    "do_to_sandbox",
  );
  assert.equal(result?.type, "agent_turn");
});

test("DO→Sandbox: init can indicate a restored workspace cache", () => {
  const result = parseInbound(
    DOToSandboxMessageSchema,
    { type: "init", repo: "https://github.com/example/app.git", restored_from_cache: true },
    "do_to_sandbox",
  );
  assert.equal(result?.type, "init");
  assert.equal(result.restored_from_cache, true);
});

test("DO→Sandbox and Sandbox→DO: consolidation messages parse", () => {
  const request = parseInbound(
    DOToSandboxMessageSchema,
    {
      type: "consolidate_annotations",
      run_id: "run_1",
      round: 0,
      plan_revision_id: "rev_1",
      plan: "## Plan",
      annotations: [
        {
          id: "ann_1",
          anchoredQuote: "Use a read-only Pi consolidation turn",
          sourceLine: 5,
          authorName: "Alice",
          comment: "Mention the sandbox contract.",
          replies: [],
        },
      ],
      model: "claude-sonnet-4-6",
    },
    "do_to_sandbox",
  );
  const complete = parseInbound(
    SandboxToDOMessageSchema,
    {
      type: "consolidation_complete",
      run_id: "run_1",
      round: 0,
      brief: "Mention the sandbox contract.",
      cost: { input_tokens: 1, output_tokens: 2, total_cost_usd: 0 },
    },
    "sandbox_to_do",
  );
  const failed = parseInbound(
    SandboxToDOMessageSchema,
    {
      type: "consolidation_failed",
      run_id: "run_1",
      round: 0,
      message: "consolidation failed",
      cost: { input_tokens: 1, output_tokens: 2, total_cost_usd: 0 },
    },
    "sandbox_to_do",
  );

  assert.equal(request?.type, "consolidate_annotations");
  assert.equal(complete?.type, "consolidation_complete");
  assert.equal(failed?.type, "consolidation_failed");
});

test("Sandbox→DO: agent turn completion, failure, and PR request parse", () => {
  const completed = parseInbound(
    SandboxToDOMessageSchema,
    { type: "agent_turn_complete", run_id: "run_1", response: "Done", cost: { input_tokens: 1, output_tokens: 2, total_cost_usd: 0 } },
    "sandbox_to_do",
  );
  const request = parseInbound(
    SandboxToDOMessageSchema,
    {
      type: "create_pr_request",
      run_id: "run_1",
      request_id: "pr_1",
      branch: "codevil/fix",
      base_branch: "main",
      title: "Fix bug",
      body: "Done",
      draft: true,
    },
    "sandbox_to_do",
  );
  const failed = parseInbound(
    SandboxToDOMessageSchema,
    { type: "agent_turn_failed", run_id: "run_2", message: "provider request failed" },
    "sandbox_to_do",
  );

  assert.equal(completed?.type, "agent_turn_complete");
  assert.equal(failed?.type, "agent_turn_failed");
  assert.equal(request?.type, "create_pr_request");
});

test("DO→CLI: agent_event opaque payload accepted", () => {
  const result = parseInbound(
    DOToCLIEventSchema,
    { type: "agent_event", event: { type: "tool_execution_start", args: {} } },
    "do_to_cli",
  );
  assert.equal(result?.type, "agent_event");
});

test("Persisted replay: lenient — unknown type passes through", () => {
  const result = parseInbound(
    PersistedDOToCLIEventSchema,
    { type: "future_event", whatever: 1 },
    "persisted_replay",
  );
  assert.equal(result?.type, "future_event");
  assert.equal(result?.whatever, 1);
});

test("Persisted replay: drops if no type field", () => {
  const drops = captureDrops(() => {
    const result = parseInbound(PersistedDOToCLIEventSchema, { foo: 1 }, "persisted_replay");
    assert.equal(result, null);
  });
  assert.equal(drops.length, 1);
});

test("Pi event: known tool_execution_start narrows", () => {
  const result = parseInbound(
    PiAgentEventSchema,
    { type: "tool_execution_start", tool: "read", toolCallId: "c1", args: { path: "/a" } },
    "pi_agent_event",
  );
  assert.equal(result?.type, "tool_execution_start");
});

test("Pi event: unknown type passes through opaquely", () => {
  const result = parseInbound(
    PiAgentEventSchema,
    { type: "agent_pause", reason: "user_input" },
    "pi_agent_event",
  );
  assert.equal(result?.type, "agent_pause");
});

test("Pi event: non-tagged object is dropped", () => {
  const drops = captureDrops(() => {
    const result = parseInbound(PiAgentEventSchema, { delta: "hi" }, "pi_agent_event");
    assert.equal(result, null);
  });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].raw_type, null);
});

test("Validation drop log captures issues from zod", () => {
  const drops = captureDrops(() => {
    parseInbound(
      SandboxToDOMessageSchema,
      { type: "plan_ready", plan: "p", cost: { input_tokens: "x" } },
      "sandbox_to_do",
    );
  });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].kind, "validation_drop");
  assert.ok(Array.isArray(drops[0].issues));
  assert.ok(drops[0].issues.length > 0);
});

// --- AnnotationAnchorSchema (new web-highlighter shape) ---

const validAnchor = {
  startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 10 },
  endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 46 },
  text: "Use a read-only Pi consolidation turn",
  blockId: "block-001",
  sourceLine: 5,
};

test("AnnotationAnchorSchema: accepts a valid anchor", () => {
  const result = AnnotationAnchorSchema.parse(validAnchor);
  assert.equal(result.text, validAnchor.text);
  assert.equal(result.sourceLine, 5);
  assert.equal(result.startMeta.parentTagName, "P");
  assert.equal(result.endMeta.textOffset, 46);
});

test("AnnotationAnchorSchema: rejects empty text", () => {
  assert.throws(() => AnnotationAnchorSchema.parse({ ...validAnchor, text: "" }));
});

test("AnnotationAnchorSchema: rejects sourceLine < 1", () => {
  assert.throws(() => AnnotationAnchorSchema.parse({ ...validAnchor, sourceLine: 0 }));
});

test("AnnotationAnchorSchema: rejects negative parentIndex in startMeta", () => {
  assert.throws(() => AnnotationAnchorSchema.parse({
    ...validAnchor,
    startMeta: { ...validAnchor.startMeta, parentIndex: -1 },
  }));
});

test("AnnotationAnchorSchema: rejects negative textOffset in endMeta", () => {
  assert.throws(() => AnnotationAnchorSchema.parse({
    ...validAnchor,
    endMeta: { ...validAnchor.endMeta, textOffset: -5 },
  }));
});

test("AnnotationAnchorSchema: rejects empty parentTagName", () => {
  assert.throws(() => AnnotationAnchorSchema.parse({
    ...validAnchor,
    startMeta: { ...validAnchor.startMeta, parentTagName: "" },
  }));
});

test("AnnotationAnchorSchema: rejects empty blockId", () => {
  assert.throws(() => AnnotationAnchorSchema.parse({ ...validAnchor, blockId: "" }));
});

test("AnnotationAnchorSchema: rejects missing startMeta", () => {
  const { startMeta: _dropped, ...rest } = validAnchor;
  assert.throws(() => AnnotationAnchorSchema.parse(rest));
});

test("AnnotationAnchorSchema: rejects missing endMeta", () => {
  const { endMeta: _dropped, ...rest } = validAnchor;
  assert.throws(() => AnnotationAnchorSchema.parse(rest));
});

test("annotation_create message parses with new anchor shape", () => {
  const result = AnnotationCreateMessageSchema.parse({
    type: "annotation_create",
    run_id: "run_1",
    round: 0,
    anchor: validAnchor,
    comment: "This needs a review.",
  });
  assert.equal(result.anchor.text, validAnchor.text);
  assert.equal(result.anchor.sourceLine, 5);
  assert.equal(result.anchor.blockId, "block-001");
});

test("annotation_create message rejects old-shape anchor (missing startMeta)", () => {
  assert.throws(() => AnnotationCreateMessageSchema.parse({
    type: "annotation_create",
    run_id: "run_1",
    round: 0,
    anchor: {
      quote: "old shape",
      prefix: "before",
      suffix: "after",
      startOffset: 0,
      endOffset: 9,
    },
    comment: "Should be rejected.",
  }));
});

test("annotation_created event parses with new anchor shape", () => {
  const annotation = {
    id: "ann_1",
    run_id: "run_1",
    round: 0,
    anchor: validAnchor,
    author: { id: "usr_1", name: "Alice" },
    comment: "Looks good.",
    status: "open",
    created_at: "2026-06-12T00:00:00.000Z",
  };
  const result = AnnotationCreatedEventSchema.parse({ type: "annotation_created", annotation });
  assert.equal(result.annotation.anchor.text, validAnchor.text);
  assert.equal(result.annotation.anchor.sourceLine, 5);
});

// --- ask_question sandbox messages ---

test("Sandbox→DO: ask_question_request parses as union member", () => {
  const result = SandboxToDOMessageSchema.parse({
    type: "ask_question_request",
    request_id: "req_1",
    run_id: "run_1",
    question: "Which approach is best?",
    options: [
      { id: "opt-1", label: "Approach A" },
      { id: "opt-2", label: "Approach B", detail: "More verbose but safer." },
    ],
    allow_freeform: true,
    allow_multiple: false,
    answerable_by: "decider",
  });
  assert.equal(result.type, "ask_question_request");
  assert.equal(result.request_id, "req_1");
  assert.equal(result.options.length, 2);
  assert.equal(result.answerable_by, "decider");
});

test("Sandbox→DO: ask_question_request parses via parseInbound", () => {
  const result = parseInbound(
    SandboxToDOMessageSchema,
    {
      type: "ask_question_request",
      request_id: "req_2",
      run_id: "run_1",
      question: "Freeform only question?",
      allow_freeform: true,
      allow_multiple: false,
      answerable_by: "anyone",
    },
    "sandbox_to_do",
  );
  assert.equal(result?.type, "ask_question_request");
  assert.equal(result?.answerable_by, "anyone");
});

test("AskQuestionRequestSchema accepts valid standalone", () => {
  const parsed = AskQuestionRequestSchema.parse({
    type: "ask_question_request",
    request_id: "req_3",
    run_id: "run_1",
    question: "Pick your option.",
    context: "Here is some context.",
    allow_freeform: false,
    allow_multiple: true,
    answerable_by: "decider",
  });
  assert.equal(parsed.context, "Here is some context.");
  assert.equal(parsed.allow_multiple, true);
});

test("DO→Sandbox: ask_question_response parses as union member", () => {
  const result = DOToSandboxMessageSchema.parse({
    type: "ask_question_response",
    request_id: "req_1",
    option_ids: ["opt-1"],
    freeform: "My extra note.",
    answered_by: { id: "usr_1", name: "Alice" },
  });
  assert.equal(result.type, "ask_question_response");
  assert.equal(result.answered_by.name, "Alice");
  assert.deepEqual(result.option_ids, ["opt-1"]);
});

test("AskQuestionResponseSchema parses via standalone", () => {
  const result = AskQuestionResponseSchema.parse({
    type: "ask_question_response",
    request_id: "req_1",
    option_ids: [],
    answered_by: { id: "usr_2", name: "Bob" },
  });
  assert.equal(result.answered_by.id, "usr_2");
});

test("DO→Sandbox: ask_question_cancelled parses as union member", () => {
  const result = DOToSandboxMessageSchema.parse({
    type: "ask_question_cancelled",
    request_id: "req_1",
    reason: "Session ended before answer was provided.",
  });
  assert.equal(result.type, "ask_question_cancelled");
  assert.equal(result.reason, "Session ended before answer was provided.");
});

test("AskQuestionCancelledSchema parses via standalone", () => {
  const result = AskQuestionCancelledSchema.parse({
    type: "ask_question_cancelled",
    request_id: "req_99",
    reason: "Timed out.",
  });
  assert.equal(result.request_id, "req_99");
});
