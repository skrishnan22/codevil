import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionSummary,
  deriveSessionTitle,
  normalizeCreateSessionBody,
  sessionDirectoryInsert,
} from "../dist/session-directory.js";

test("deriveSessionTitle uses owner/repo for GitHub URLs", () => {
  assert.equal(deriveSessionTitle("https://github.com/acme/app.git"), "acme/app");
  assert.equal(deriveSessionTitle("github.com/acme/app"), "acme/app");
});

test("deriveSessionTitle falls back to raw repo for unknown formats", () => {
  assert.equal(deriveSessionTitle("ssh://git.example.com/platform"), "ssh://git.example.com/platform");
});

test("normalizeCreateSessionBody accepts repo-only creation and defaults runtime fields", () => {
  const result = normalizeCreateSessionBody({
    repo: "github.com/acme/app",
    provider: "openai",
    plan_model: "gpt-5.4",
    exec_model: "gpt-5.4-mini",
    max_idle_time: "10m",
    max_session_time: "30m",
  });

  assert.equal(result.repo, "github.com/acme/app");
  assert.equal(result.provider, "openai");
  assert.equal(result.title, "acme/app");
  assert.equal(result.max_idle_time, "10m");
  assert.equal(result.max_session_time, "30m");
});

test("normalizeCreateSessionBody rejects prompt-based creation", () => {
  assert.throws(() => {
    normalizeCreateSessionBody({
      prompt: "add tests",
      repo: "github.com/acme/app",
    });
  }, /prompt/i);
});

test("buildSessionSummary maps D1 rows to public summaries", () => {
  const summary = buildSessionSummary({
    id: "ses_123",
    title: "acme/app",
    repo: "github.com/acme/app",
    room_state: "ready",
    sandbox_state: "ready",
    active_run_state: null,
    created_by_id: "usr_123",
    created_by_name: "Alice",
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:01.000Z",
    last_event_at: "2026-06-03T00:00:02.000Z",
  });

  assert.deepEqual(summary, {
    id: "ses_123",
    title: "acme/app",
    repo: "github.com/acme/app",
    room_state: "ready",
    sandbox_state: "ready",
    created_by: { id: "usr_123", name: "Alice" },
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:01.000Z",
    last_event_at: "2026-06-03T00:00:02.000Z",
  });
});

test("sessionDirectoryInsert returns SQL and bindings for a new row", () => {
  const insert = sessionDirectoryInsert({
    id: "ses_123",
    title: "acme/app",
    repo: "github.com/acme/app",
    provider: "openai",
    plan_model: "gpt-5.4",
    exec_model: "gpt-5.4-mini",
    max_cost: "2",
    max_session_time: "30m",
    max_idle_time: "10m",
    max_steps: 200,
    room_state: "initializing",
    sandbox_state: "not_started",
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    last_event_at: "2026-06-03T00:00:00.000Z",
  });

  assert.match(insert.sql, /^INSERT INTO sessions/i);
  assert.equal(insert.bindings[0], "ses_123");
  assert.equal(insert.bindings[1], "github.com/acme/app");
});
