import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldPauseSandbox, idlePauseDeadline, sandboxLeaseMs, leaseRenewDeadline, SANDBOX_LEASE_RENEW_INTERVAL_MS,
} from "../dist/orchestrator/sandbox-lifecycle.js";
import { nextAlarmDeadline } from "../dist/orchestrator/alarm.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const idle = (overrides = {}) => ({
  now: T0 + 10 * 60_000, pauseSupported: true, sessionState: "ready", paused: false, sandboxConnected: true,
  hasActiveRun: false, queuedRuns: 0, openQuestions: 0, lastActivityAt: "2026-10-01T00:00:00.000Z", maxIdleMs: 600_000,
  ...overrides,
});

test("pauses an idle, connected, ready sandbox at the idle deadline", () => {
  assert.equal(shouldPauseSandbox(idle()), true);
  assert.equal(shouldPauseSandbox(idle({ now: T0 + 599_999 })), false);
});

for (const [name, overrides] of [
  ["provider without pause", { pauseSupported: false }],
  ["already paused", { paused: true }],
  ["cloning", { sessionState: "cloning_repo" }],
  ["socket not attached", { sandboxConnected: false }],
  ["mid-reconnect", { disconnectedAt: "2026-10-01T00:09:00.000Z" }],
  ["active run", { hasActiveRun: true }],
  ["queued run", { queuedRuns: 1 }],
  ["open question", { openQuestions: 1 }],
  ["idle disabled", { maxIdleMs: null }],
]) {
  test(`never pauses when ${name}`, () => {
    assert.equal(shouldPauseSandbox(idle(overrides)), false);
  });
}

test("idle deadline follows the last activity", () => {
  assert.equal(idlePauseDeadline({ lastActivityAt: "2026-10-01T00:00:00.000Z", maxIdleMs: 600_000 }), T0 + 600_000);
  assert.equal(idlePauseDeadline({ lastActivityAt: "2026-10-01T00:00:00.000Z", maxIdleMs: null }), null);
});

test("lease is the shorter of remaining session time and the provider cap, at least one minute", () => {
  assert.equal(sandboxLeaseMs({ now: T0, createdAt: T0, maxTimeMs: 15 * 60_000, providerMaxMs: 3_600_000 }), 15 * 60_000);
  assert.equal(sandboxLeaseMs({ now: T0, createdAt: T0, maxTimeMs: 4 * 3_600_000, providerMaxMs: 3_600_000 }), 3_600_000);
  assert.equal(sandboxLeaseMs({ now: T0 + 15 * 60_000, createdAt: T0, maxTimeMs: 15 * 60_000, providerMaxMs: 3_600_000 }), 60_000);
  assert.equal(sandboxLeaseMs({ now: T0, createdAt: T0, maxTimeMs: null, providerMaxMs: 3_600_000 }), 3_600_000);
});

test("lease renewal deadline", () => {
  assert.equal(leaseRenewDeadline({ createdAt: "2026-10-01T00:00:00.000Z" }), T0 + SANDBOX_LEASE_RENEW_INTERVAL_MS);
});

test("alarm includes idle pause and lease renewal deadlines", () => {
  const base = { now: T0 + 120_000, state: "ready", createdAt: T0, maxTimeMs: null };
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: T0 + 200_000, leaseRenewAt: T0 + 300_000 }), T0 + 200_000);
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: null, leaseRenewAt: T0 + 300_000 }), T0 + 300_000);
  assert.equal(nextAlarmDeadline({ ...base, state: "failed", idlePauseAt: T0 + 200_000 }), undefined);
});
