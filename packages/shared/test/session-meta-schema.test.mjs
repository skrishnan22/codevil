import assert from "node:assert/strict";
import test from "node:test";

import { SessionMetaSchema } from "../dist/index.js";

test("SessionMetaSchema: accepts a minimal valid meta blob", () => {
  const parsed = SessionMetaSchema.parse({
    session_id: "ses_1",
    prompt: "",
    repo: "https://github.com/acme/app.git",
    worker_url: "https://worker.example",
    provider: "opencode-go",
    plan_model: "kimi-k2.6",
    exec_model: "kimi-k2.6",
    max_time: "15m",
    state: "ready",
    refinement_round: 0,
    verification_attempts: 0,
    cost_total_usd: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(parsed.session_id, "ses_1");
  assert.deepEqual(parsed.queued_runs, []);
});

test("SessionMetaSchema: rejects invalid session state", () => {
  assert.throws(() => SessionMetaSchema.parse({
    session_id: "ses_1",
    prompt: "",
    repo: "https://github.com/acme/app.git",
    worker_url: "https://worker.example",
    provider: "opencode-go",
    plan_model: "kimi-k2.6",
    exec_model: "kimi-k2.6",
    max_time: "15m",
    state: "not_a_state",
    refinement_round: 0,
    verification_attempts: 0,
    cost_total_usd: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  }));
});
