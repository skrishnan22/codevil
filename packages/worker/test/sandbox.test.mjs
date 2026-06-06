import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSandboxWebSocketUrl,
  mapSandboxMessageToCLIEvents,
  retrySandboxOperation,
  sandboxProcessEnv,
} from "../dist/sandbox.js";

test("builds sandbox WebSocket URL from worker origin", () => {
  assert.equal(
    buildSandboxWebSocketUrl("https://codevil.example.com/sessions", "ses_123"),
    "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
  );
});

test("builds sandbox process env without exposing llm key", () => {
  assert.deepEqual(sandboxProcessEnv({
    wsUrl: "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
    apiKey: "secret",
    provider: "anthropic",
  }), {
    CODEVIL_DO_WS_URL: "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
    CODEVIL_API_KEY: "secret",
    CODEVIL_WORKSPACE: "/workspace",
    CODEVIL_PROVIDER: "anthropic",
    CODEVIL_LLM_KEY_FILE: "/run/secrets/llm_key",
  });
});

test("retries transient sandbox 503 failures", async () => {
  const sleeps = [];
  let calls = 0;

  const result = await retrySandboxOperation(async () => {
    calls++;
    if (calls === 1) {
      throw new Error("Failed to create session: 503");
    }
    return "started";
  }, {
    attempts: 2,
    baseDelayMs: 25,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });

  assert.equal(result, "started");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [25]);
});

test("retries transient container startup failures", async () => {
  const sleeps = [];
  let calls = 0;

  const result = await retrySandboxOperation(async () => {
    calls++;
    if (calls <= 2) {
      throw new Error("Failed to create session: 500");
    }
    return "started";
  }, {
    attempts: 4,
    baseDelayMs: 25,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });

  assert.equal(result, "started");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [25, 50]);
});

test("does not retry non-transient sandbox failures", async () => {
  let calls = 0;

  await assert.rejects(
    retrySandboxOperation(async () => {
      calls++;
      throw new Error("Permission denied");
    }, {
      attempts: 3,
      baseDelayMs: 25,
      sleep: async () => {},
    }),
    /Permission denied/,
  );

  assert.equal(calls, 1);
});

test("maps sandbox protocol messages to CLI events", () => {
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "clone_started" }), []);
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "clone_complete" }), []);
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "verification_started", attempt: 1, max_attempts: 5 }), []);
  assert.deepEqual(mapSandboxMessageToCLIEvents({
    type: "verification_retrying",
    attempt: 1,
    max_attempts: 5,
    last_error: "failed",
  }), []);
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "status", message: "ready" }), [
    { type: "status", message: "ready" },
  ]);
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "clone_progress", line: "cloning" }), [
    { type: "clone_progress", line: "cloning" },
  ]);
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "agent_event", event: { type: "turn_start" } }), [
    { type: "agent_event", event: { type: "turn_start" } },
  ]);
  assert.deepEqual(mapSandboxMessageToCLIEvents({
    type: "agent_turn_complete",
    run_id: "run_1",
    response: "Done",
    cost: { input_tokens: 1, output_tokens: 1, total_cost_usd: 0.01 },
  }), []);
  assert.deepEqual(mapSandboxMessageToCLIEvents({
    type: "create_pr_request",
    run_id: "run_1",
    request_id: "pr_1",
    branch: "codevil/change",
    base_branch: "main",
    title: "Change",
    body: "Details",
    draft: true,
  }), []);
  assert.deepEqual(mapSandboxMessageToCLIEvents({
    type: "credential_request",
    request_id: "cred_1",
    protocol: "https",
    host: "github.com",
    path: "acme/app.git",
  }), [
    { type: "status", message: "Credential requested for github.com." },
  ]);
  assert.deepEqual(mapSandboxMessageToCLIEvents({
    type: "branch_pushed",
    branch: "codevil/change",
    base_branch: "main",
    pr_title: "Change",
    pr_body: "Plan",
  }), [
    { type: "status", message: "Branch pushed: codevil/change." },
  ]);
  assert.deepEqual(mapSandboxMessageToCLIEvents({ type: "pr_created", url: "https://github.com/acme/app/pull/1" }), [
    { type: "complete", pr_url: "https://github.com/acme/app/pull/1" },
  ]);
});
