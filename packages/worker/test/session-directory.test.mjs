import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreateSessionResponse,
  buildSessionSummary,
  deriveSessionTitle,
  normalizeCreateSessionBody,
  normalizeIdempotencyKey,
  runSessionDirectoryUpdateWithRetry,
  sessionDirectoryInsert,
  sessionIdempotencyInsert,
  sessionIdempotencyLookup,
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

test("normalizeIdempotencyKey trims and validates keys", () => {
  assert.equal(normalizeIdempotencyKey("  abc-123  "), "abc-123");
  assert.throws(() => normalizeIdempotencyKey("bad key"), /letters, numbers/i);
  assert.throws(() => normalizeIdempotencyKey("x".repeat(300)), /at most/i);
});

test("sessionIdempotencyLookup scopes by user and key", () => {
  const lookup = sessionIdempotencyLookup("usr_1", "req-1");
  assert.match(lookup.sql, /session_idempotency/i);
  assert.deepEqual(lookup.bindings, ["usr_1", "req-1"]);
});

test("sessionIdempotencyInsert stores the session mapping", () => {
  const insert = sessionIdempotencyInsert({
    user_id: "usr_1",
    idempotency_key: "req-1",
    session_id: "ses_1",
    created_at: "2026-07-03T00:00:00.000Z",
  });
  assert.match(insert.sql, /INSERT INTO session_idempotency/i);
  assert.deepEqual(insert.bindings[2], "ses_1");
});

test("buildCreateSessionResponse builds ws_url and summary", () => {
  const response = buildCreateSessionResponse("ses_123", "https://worker.example/sessions", {
    id: "ses_123",
    title: "acme/app",
    repo: "github.com/acme/app",
    room_state: "initializing",
    sandbox_state: "not_started",
    provider: "openai",
    plan_model: "gpt-5.4",
    exec_model: "gpt-5.4-mini",
    max_cost: "",
    max_session_time: "30m",
    max_idle_time: "10m",
    max_steps: 0,
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
    last_event_at: "2026-07-03T00:00:00.000Z",
  });

  assert.equal(response.session_id, "ses_123");
  assert.equal(response.ws_url, "https://worker.example/sessions/ses_123/ws");
  assert.equal(response.summary.title, "acme/app");
});

test("runSessionDirectoryUpdateWithRetry succeeds on first attempt", async () => {
  let calls = 0;
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              calls++;
            },
          };
        },
      };
    },
  };

  await runSessionDirectoryUpdateWithRetry(db, "UPDATE sessions SET room_state = ?", ["ready"], {
    onFailure: () => assert.fail("should not fail"),
  });

  assert.equal(calls, 1);
});

test("runSessionDirectoryUpdateWithRetry retries then succeeds", async () => {
  let calls = 0;
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              calls++;
              if (calls < 2) throw new Error("transient");
            },
          };
        },
      };
    },
  };

  await runSessionDirectoryUpdateWithRetry(db, "UPDATE sessions SET room_state = ?", ["ready"], {
    attempts: 3,
    backoffMs: 1,
    onFailure: () => assert.fail("should not fail"),
  });

  assert.equal(calls, 2);
});

test("runSessionDirectoryUpdateWithRetry calls onFailure after exhausting retries", async () => {
  let calls = 0;
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              calls++;
              throw new Error("persistent");
            },
          };
        },
      };
    },
  };

  let failureError = null;
  await runSessionDirectoryUpdateWithRetry(db, "UPDATE sessions SET room_state = ?", ["ready"], {
    attempts: 2,
    backoffMs: 1,
    onFailure: (error) => { failureError = error; },
  });

  assert.equal(calls, 2);
  assert.equal(failureError?.message, "persistent");
});
