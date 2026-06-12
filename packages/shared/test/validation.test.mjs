import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIToDOMessageSchema,
  SandboxToDOMessageSchema,
  DOToSandboxMessageSchema,
  DOToCLIEventSchema,
  PersistedDOToCLIEventSchema,
  PiAgentEventSchema,
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

test("CLI→DO: conflict_resolve requires exactly one resolution field", () => {
  const drops = captureDrops(() => {
    const missing = parseInbound(
      CLIToDOMessageSchema,
      { type: "conflict_resolve", conflict_id: "conf_1" },
      "cli_to_do",
    );
    const conflicting = parseInbound(
      CLIToDOMessageSchema,
      {
        type: "conflict_resolve",
        conflict_id: "conf_1",
        selected_thread_id: "ann_1",
        deciding_instruction: "Use the read-only consolidation path.",
      },
      "cli_to_do",
    );

    assert.equal(missing, null);
    assert.equal(conflicting, null);
  });

  assert.equal(drops.length, 2);
  assert.equal(drops[0].raw_type, "conflict_resolve");
  assert.equal(drops[1].raw_type, "conflict_resolve");
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
          run_id: "run_1",
          round: 0,
          anchor: {
            quote: "Use a read-only Pi consolidation turn",
            prefix: "Resolve conflicts by calling",
            suffix: "then dispatch a brief.",
            startOffset: 10,
            endOffset: 46,
          },
          author: { id: "usr_1", name: "Alice" },
          comment: "Mention the sandbox contract.",
          status: "open",
          created_at: "2026-06-12T00:00:00.000Z",
        },
      ],
      conflicts: [],
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
      brief_items: [
        { instruction: "Mention the sandbox contract.", source_thread_ids: ["ann_1"] },
      ],
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
      message: "conflict remains",
      cost: { input_tokens: 1, output_tokens: 2, total_cost_usd: 0 },
    },
    "sandbox_to_do",
  );

  assert.equal(request?.type, "consolidate_annotations");
  assert.equal(complete?.type, "consolidation_complete");
  assert.equal(failed?.type, "consolidation_failed");
});

test("Sandbox→DO: agent turn completion and PR request parse", () => {
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

  assert.equal(completed?.type, "agent_turn_complete");
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
