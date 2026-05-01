import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionPayload,
  buildWebSocketUrl,
  createSession,
} from "../dist/session-client.js";

test("builds session payload from run command and config defaults", () => {
  assert.deepEqual(buildSessionPayload({
    type: "run",
    repo: "https://github.com/example/app",
    prompt: "add rate limits",
    provider: undefined,
    planModel: undefined,
    execModel: "executor",
    maxCost: undefined,
    maxTime: "20m",
    maxSteps: undefined,
  }, {
    endpoint: "https://codevil.example.com",
    api_key: "secret",
    defaults: {
      plan_model: "planner",
      exec_model: "default-executor",
      provider: "anthropic",
      max_cost: "$2",
      max_time: "15m",
      max_steps: 50,
    },
  }), {
    prompt: "add rate limits",
    repo: "https://github.com/example/app",
    provider: "anthropic",
    plan_model: "planner",
    exec_model: "executor",
    max_cost: "$2",
    max_time: "20m",
    max_steps: 50,
  });
});

test("creates sessions with bearer auth", async () => {
  const calls = [];
  const response = await createSession(
    {
      endpoint: "https://codevil.example.com/",
      api_key: "secret",
      defaults: {
        plan_model: "planner",
        exec_model: "executor",
        provider: "anthropic",
        max_cost: "$2",
        max_time: "15m",
        max_steps: 50,
      },
    },
    {
      type: "run",
      repo: "https://github.com/example/app",
      prompt: "add rate limits",
      provider: "openai",
      planModel: undefined,
      execModel: undefined,
      maxCost: undefined,
      maxTime: undefined,
      maxSteps: undefined,
    },
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        session_id: "ses_123",
        ws_url: "https://codevil.example.com/sessions/ses_123/ws",
      }), { status: 201 });
    },
  );

  assert.deepEqual(response, {
    session_id: "ses_123",
    ws_url: "https://codevil.example.com/sessions/ses_123/ws",
  });
  assert.equal(calls[0].url, "https://codevil.example.com/sessions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
});

test("includes error detail from JSON error responses", async () => {
  await assert.rejects(
    createSession(
      {
        endpoint: "https://codevil.example.com",
        api_key: "secret",
        defaults: {
          plan_model: "planner",
          exec_model: "executor",
          provider: "anthropic",
          max_cost: "$2",
          max_time: "15m",
          max_steps: 50,
        },
      },
      {
        type: "run",
        repo: "https://github.com/example/app",
        prompt: "test",
        provider: undefined,
        planModel: undefined,
        execModel: undefined,
        maxCost: undefined,
        maxTime: undefined,
        maxSteps: undefined,
      },
      async () => new Response(JSON.stringify({
        error: "Failed to initialize session",
        detail: "SQL storage unavailable",
      }), { status: 500, headers: { "Content-Type": "application/json" } }),
    ),
    /SQL storage unavailable/,
  );
});

test("converts HTTP session URLs into WebSocket URLs with cursor", () => {
  assert.equal(
    buildWebSocketUrl("https://codevil.example.com/sessions/ses_123/ws", 42),
    "wss://codevil.example.com/sessions/ses_123/ws?cursor=42",
  );
  assert.equal(
    buildWebSocketUrl("http://localhost:8787/sessions/ses_123/ws?debug=1", 0),
    "ws://localhost:8787/sessions/ses_123/ws?debug=1&cursor=0",
  );
});
