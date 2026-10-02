import assert from "node:assert/strict";
import test from "node:test";

import { buildInitialSessionMeta } from "../dist/orchestrator/initial-meta.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");

test("buildInitialSessionMeta defaults max_idle_time and sandbox_provider", () => {
  const meta = buildInitialSessionMeta("ses_1", "acme/app", "github.com/acme/app", {
    worker_url: "https://w",
  }, NOW);

  assert.equal(meta.max_idle_time, "10m");
  assert.equal(meta.sandbox_provider, "cloudflare");
  assert.equal(meta.state, "initializing");
});

test("buildInitialSessionMeta preserves an explicit max_idle_time and sandbox_provider", () => {
  const meta = buildInitialSessionMeta("ses_1", "acme/app", "github.com/acme/app", {
    worker_url: "https://w",
    max_idle_time: "45m",
    sandbox_provider: "e2b",
  }, NOW);

  assert.equal(meta.max_idle_time, "45m");
  assert.equal(meta.sandbox_provider, "e2b");
});

test("buildInitialSessionMeta seeds last_activity_at from created_at", () => {
  const meta = buildInitialSessionMeta("ses_1", "acme/app", "github.com/acme/app", {
    worker_url: "https://w",
  }, NOW);

  assert.equal(meta.created_at, "2026-10-01T00:00:00.000Z");
  assert.equal(meta.last_activity_at, meta.created_at);
});
