import assert from "node:assert/strict";
import test from "node:test";

import { createSession } from "../dist/session-service.js";
import { normalizeCreateSessionBody } from "../dist/session-directory.js";

test("createSession inserts a session, initializes the orchestrator, and returns session payload", async () => {
  const db = createFakeDb();
  let capturedId = null;
  let initCall = null;
  const env = {
    DB: db,
    ORCHESTRATOR: {
      idFromName(name) {
        capturedId = name;
        return `do:${name}`;
      },
      get(id) {
        assert.equal(id, `do:${capturedId}`);
        return {
          async init(...args) {
            initCall = args;
          },
        };
      },
    },
  };
  const normalized = normalizeCreateSessionBody({ repo: "github.com/acme/app" });

  const result = await createSession(
    env,
    "https://codevil.example.workers.dev/api/sessions",
    { repo: "github.com/acme/app" },
    { id: "usr_123", name: "Alice", email: "alice@example.com" },
  );

  assert.match(result.session_id, /^ses_[a-f0-9]{32}$/);
  assert.equal(result.ws_url, `https://codevil.example.workers.dev/sessions/${result.session_id}/ws`);
  assert.deepEqual(result.summary, {
    id: result.session_id,
    title: "acme/app",
    repo: "github.com/acme/app",
    room_state: "initializing",
    sandbox_state: "not_started",
    created_by: { id: "usr_123", name: "Alice" },
    created_at: result.summary.created_at,
    updated_at: result.summary.updated_at,
    last_event_at: result.summary.last_event_at,
  });
  assert.equal(db.rows.size, 1);
  assert.deepEqual(db.rows.get(result.session_id), {
    id: result.session_id,
    repo: "github.com/acme/app",
    title: "acme/app",
    provider: normalized.provider,
    plan_model: normalized.plan_model,
    exec_model: normalized.exec_model,
    max_cost: "",
    max_session_time: normalized.max_session_time,
    max_idle_time: normalized.max_idle_time,
    max_steps: 0,
    room_state: "initializing",
    sandbox_state: "not_started",
    active_run_state: null,
    created_by_id: "usr_123",
    created_by_name: "Alice",
    created_by_email: "alice@example.com",
    created_at: result.summary.created_at,
    updated_at: result.summary.updated_at,
    last_event_at: result.summary.last_event_at,
  });
  assert.deepEqual(initCall, [
    result.session_id,
    "acme/app",
    "github.com/acme/app",
    {
      worker_url: "https://codevil.example.workers.dev",
      provider: normalized.provider,
      plan_model: normalized.plan_model,
      exec_model: normalized.exec_model,
      max_time: normalized.max_session_time,
      created_by: { id: "usr_123", name: "Alice" },
    },
  ]);
});

test("createSession marks the session failed when orchestrator init throws", async () => {
  const db = createFakeDb();
  const env = {
    DB: db,
    ORCHESTRATOR: {
      idFromName(name) {
        return name;
      },
      get() {
        return {
          async init() {
            throw new Error("boom");
          },
        };
      },
    },
  };

  await assert.rejects(
    () => createSession(
      env,
      "https://codevil.example.workers.dev",
      { repo: "github.com/acme/app" },
      { id: "usr_123", name: "Alice" },
    ),
    /boom/,
  );

  assert.equal(db.rows.size, 1);
  const [failedRow] = db.rows.values();
  assert.equal(failedRow.room_state, "failed");
  assert.equal(failedRow.sandbox_state, "failed");
});

function createFakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      const state = { bindings: [] };
      return {
        bind(...bindings) {
          state.bindings = bindings;
          return this;
        },
        async run() {
          if (/INSERT INTO sessions/i.test(sql)) {
            const [
              id,
              repo,
              title,
              provider,
              planModel,
              execModel,
              maxCost,
              maxSessionTime,
              maxIdleTime,
              maxSteps,
              roomState,
              sandboxState,
              activeRunState,
              createdById,
              createdByName,
              createdByEmail,
              createdAt,
              updatedAt,
              lastEventAt,
            ] = state.bindings;
            rows.set(id, {
              id,
              repo,
              title,
              provider,
              plan_model: planModel,
              exec_model: execModel,
              max_cost: maxCost,
              max_session_time: maxSessionTime,
              max_idle_time: maxIdleTime,
              max_steps: maxSteps,
              room_state: roomState,
              sandbox_state: sandboxState,
              active_run_state: activeRunState,
              created_by_id: createdById,
              created_by_name: createdByName,
              created_by_email: createdByEmail,
              created_at: createdAt,
              updated_at: updatedAt,
              last_event_at: lastEventAt,
            });
          } else if (/UPDATE sessions SET room_state = \?, sandbox_state = \?, updated_at = \?, last_event_at = \? WHERE id = \?/i.test(sql)) {
            const [roomState, sandboxState, updatedAt, lastEventAt, id] = state.bindings;
            const existing = rows.get(id);
            rows.set(id, {
              ...existing,
              room_state: roomState,
              sandbox_state: sandboxState,
              updated_at: updatedAt,
              last_event_at: lastEventAt,
            });
          }
          return { success: true };
        },
      };
    },
  };
}
