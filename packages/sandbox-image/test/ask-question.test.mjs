import assert from "node:assert/strict";
import test from "node:test";

import { SandboxRuntime } from "../dist/runtime.js";
import { askQuestionTool } from "../dist/pi-driver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(options = {}) {
  const sent = [];
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => { throw new Error("agent not expected in ask_question tests"); },
    git: {
      async clone() {},
      async defaultBranch() { return "main"; },
      async pushBranch() {},
    },
    credentialTimeoutMs: 0,
    ...options,
  });
  return { runtime, sent };
}

// ---------------------------------------------------------------------------
// Bridge round-trip tests
// ---------------------------------------------------------------------------

test("ask_question_response resolves askQuestion with the answered outcome", async () => {
  const { runtime, sent } = makeRuntime();

  const params = {
    question: "Which storage engine should we use?",
    context: "The plan mentions both Redis and D1.",
    options: [
      { id: "opt_redis", label: "Redis" },
      { id: "opt_d1", label: "D1" },
    ],
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
  };

  const promise = runtime.askQuestion("run_1", params);

  // Exactly one ask_question_request was sent with correct fields.
  const requests = sent.filter((m) => m.type === "ask_question_request");
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.ok(typeof req.request_id === "string" && req.request_id.length > 0, "request_id must be a non-empty string");
  assert.equal(req.run_id, "run_1");
  assert.equal(req.question, params.question);
  assert.equal(req.context, params.context);
  assert.deepEqual(req.options, params.options);
  assert.equal(req.allow_freeform, false);
  assert.equal(req.allow_multiple, false);
  assert.equal(req.answerable_by, "decider");

  // Simulate DO sending a response back.
  const answeredBy = { id: "user_alice", name: "Alice" };
  await runtime.handleMessage({
    type: "ask_question_response",
    request_id: req.request_id,
    option_ids: ["opt_d1"],
    answered_by: answeredBy,
  });

  const outcome = await promise;
  assert.equal(outcome.cancelled, false);
  assert.deepEqual(outcome.option_ids, ["opt_d1"]);
  assert.equal(outcome.freeform, undefined);
  assert.deepEqual(outcome.answered_by, answeredBy);
});

test("ask_question_response with freeform propagates it in the outcome", async () => {
  const { runtime, sent } = makeRuntime();

  const promise = runtime.askQuestion("run_2", {
    question: "Any other thoughts?",
    allow_freeform: true,
    allow_multiple: false,
    answerable_by: "anyone",
  });

  const req = sent.find((m) => m.type === "ask_question_request");
  assert.ok(req, "expected an ask_question_request to be sent");

  await runtime.handleMessage({
    type: "ask_question_response",
    request_id: req.request_id,
    option_ids: [],
    freeform: "Please use Postgres instead.",
    answered_by: { id: "user_bob", name: "Bob" },
  });

  const outcome = await promise;
  assert.equal(outcome.cancelled, false);
  assert.deepEqual(outcome.option_ids, []);
  assert.equal(outcome.freeform, "Please use Postgres instead.");
});

test("ask_question_cancelled resolves askQuestion with the cancelled outcome", async () => {
  const { runtime, sent } = makeRuntime();

  const promise = runtime.askQuestion("run_3", {
    question: "What colour should the header be?",
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
  });

  const req = sent.find((m) => m.type === "ask_question_request");

  await runtime.handleMessage({
    type: "ask_question_cancelled",
    request_id: req.request_id,
    reason: "Session was aborted by the user.",
  });

  const outcome = await promise;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.reason, "Session was aborted by the user.");
});

test("ask_question_response with unknown request_id is ignored (no throw, promise stays pending)", async () => {
  const { runtime, sent } = makeRuntime();

  const promise = runtime.askQuestion("run_4", {
    question: "Pick a database.",
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
  });

  const req = sent.find((m) => m.type === "ask_question_request");
  assert.ok(req, "expected an ask_question_request");

  // Send a response for a completely different request_id — must not throw.
  await assert.doesNotReject(
    runtime.handleMessage({
      type: "ask_question_response",
      request_id: "q_unknown_xyz",
      option_ids: ["opt_x"],
      answered_by: { id: "user_a", name: "A" },
    }),
  );

  // The real promise is still pending (we race with a short timeout).
  let resolved = false;
  promise.then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "promise should still be pending after unknown response");

  // Clean up — resolve it with the real id.
  await runtime.handleMessage({
    type: "ask_question_response",
    request_id: req.request_id,
    option_ids: [],
    answered_by: { id: "user_a", name: "A" },
  });
  await promise;
});

test("makeAskQuestion returns a run-bound callback that sends ask_question_request with the correct run_id", async () => {
  const { runtime, sent } = makeRuntime();

  const ask = runtime.makeAskQuestion("run_bound");
  const promise = ask({
    question: "Confirm direction?",
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
  });

  const req = sent.find((m) => m.type === "ask_question_request");
  assert.equal(req.run_id, "run_bound");

  // Resolve to avoid dangling promise.
  await runtime.handleMessage({
    type: "ask_question_response",
    request_id: req.request_id,
    option_ids: [],
    answered_by: { id: "u1", name: "U1" },
  });
  await promise;
});

// ---------------------------------------------------------------------------
// Tool execute tests
// ---------------------------------------------------------------------------

test("askQuestionTool execute returns a summary of the selected options when answered", async () => {
  const stubOutcome = {
    cancelled: false,
    option_ids: ["opt_d1"],
    freeform: undefined,
    answered_by: { id: "user_alice", name: "Alice" },
  };

  const tool = askQuestionTool(async () => stubOutcome);

  const result = await tool.execute("call_1", {
    question: "Which DB?",
    options: [
      { id: "opt_redis", label: "Redis" },
      { id: "opt_d1", label: "D1" },
    ],
    allow_freeform: false,
    allow_multiple: false,
    answerable_by: "decider",
  });

  const text = result.content[0].text;
  assert.ok(text.includes("D1"), `expected 'D1' in text: ${text}`);
  assert.ok(text.includes("opt_d1"), `expected 'opt_d1' in text: ${text}`);
  assert.ok(text.includes("Alice"), `expected 'Alice' in text: ${text}`);
  assert.deepEqual(result.details, stubOutcome);
});

test("askQuestionTool execute includes freeform reply in the result text", async () => {
  const stubOutcome = {
    cancelled: false,
    option_ids: [],
    freeform: "Use Postgres please.",
    answered_by: { id: "user_bob", name: "Bob" },
  };

  const tool = askQuestionTool(async () => stubOutcome);

  const result = await tool.execute("call_2", {
    question: "Any preference?",
    allow_freeform: true,
    allow_multiple: false,
  });

  const text = result.content[0].text;
  assert.ok(text.includes("Use Postgres please."), `expected freeform in text: ${text}`);
  assert.ok(text.includes("Bob"), `expected answerer name in text: ${text}`);
});

test("askQuestionTool execute returns cancelled note when question is cancelled", async () => {
  const stubOutcome = {
    cancelled: true,
    reason: "Session ended by user.",
  };

  const tool = askQuestionTool(async () => stubOutcome);

  const result = await tool.execute("call_3", {
    question: "What theme?",
    allow_freeform: false,
    allow_multiple: false,
  });

  const text = result.content[0].text;
  assert.ok(text.toLowerCase().includes("cancelled"), `expected 'cancelled' in text: ${text}`);
  assert.ok(text.includes("Session ended by user."), `expected reason in text: ${text}`);
  assert.deepEqual(result.details, stubOutcome);
});

test("askQuestionTool normalizes defaults: allow_freeform, allow_multiple default to false; answerable_by defaults to 'decider'", async () => {
  const calls = [];

  const tool = askQuestionTool(async (params) => {
    calls.push(params);
    return {
      cancelled: false,
      option_ids: [],
      freeform: undefined,
      answered_by: { id: "u1", name: "U" },
    };
  });

  // Pass only required field — omit all optional booleans and answerable_by.
  await tool.execute("call_4", { question: "Simple question?" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].allow_freeform, false, "allow_freeform should default to false");
  assert.equal(calls[0].allow_multiple, false, "allow_multiple should default to false");
  assert.equal(calls[0].answerable_by, "decider", "answerable_by should default to 'decider'");
});

test("askQuestionTool passes all params through to the callback", async () => {
  const calls = [];

  const tool = askQuestionTool(async (params) => {
    calls.push(params);
    return {
      cancelled: false,
      option_ids: ["opt_a"],
      answered_by: { id: "u1", name: "U" },
    };
  });

  await tool.execute("call_5", {
    question: "Which approach?",
    context: "Background info",
    options: [{ id: "opt_a", label: "Option A" }],
    allow_freeform: true,
    allow_multiple: true,
    answerable_by: "anyone",
  });

  assert.equal(calls[0].question, "Which approach?");
  assert.equal(calls[0].context, "Background info");
  assert.deepEqual(calls[0].options, [{ id: "opt_a", label: "Option A" }]);
  assert.equal(calls[0].allow_freeform, true);
  assert.equal(calls[0].allow_multiple, true);
  assert.equal(calls[0].answerable_by, "anyone");
});
