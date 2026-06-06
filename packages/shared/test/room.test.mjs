import assert from "node:assert/strict";
import test from "node:test";

import {
  CreateSessionRequestSchema,
  GetSessionResponseSchema,
  ListSessionsResponseSchema,
} from "../dist/room.js";

test("CreateSessionRequestSchema accepts repo-only session creation", () => {
  const parsed = CreateSessionRequestSchema.parse({
    repo: "github.com/acme/app",
    provider: "openai",
    plan_model: "gpt-5.4",
    exec_model: "gpt-5.4-mini",
    max_idle_time: "10m",
    max_session_time: "30m",
    max_steps: 200,
  });

  assert.equal(parsed.repo, "github.com/acme/app");
  assert.equal(parsed.provider, "openai");
});

test("CreateSessionRequestSchema rejects prompt-based task creation", () => {
  assert.throws(() => {
    CreateSessionRequestSchema.parse({
      prompt: "add tests",
      repo: "github.com/acme/app",
    });
  });
});

test("ListSessionsResponseSchema parses cloud session summaries", () => {
  const now = "2026-06-03T00:00:00.000Z";
  const parsed = ListSessionsResponseSchema.parse({
    sessions: [
      {
        id: "ses_123",
        title: "acme/app",
        repo: "github.com/acme/app",
        room_state: "ready",
        sandbox_state: "stopped",
        created_at: now,
        updated_at: now,
        last_event_at: now,
      },
    ],
  });

  assert.equal(parsed.sessions[0].title, "acme/app");
  assert.equal(parsed.sessions[0].sandbox_state, "stopped");
});

test("GetSessionResponseSchema includes join websocket URL", () => {
  const now = "2026-06-03T00:00:00.000Z";
  const parsed = GetSessionResponseSchema.parse({
    session: {
      id: "ses_123",
      title: "acme/app",
      repo: "github.com/acme/app",
      room_state: "ready",
      sandbox_state: "ready",
      created_at: now,
      updated_at: now,
      last_event_at: now,
    },
    ws_url: "https://worker.example.com/sessions/ses_123/ws",
  });

  assert.equal(parsed.ws_url, "https://worker.example.com/sessions/ses_123/ws");
});
