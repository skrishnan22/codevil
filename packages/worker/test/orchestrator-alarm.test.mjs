import assert from "node:assert/strict";
import test from "node:test";

const alarmModule = await import("../dist/orchestrator/alarm.js").catch(() => null);

test("rearms the reconnect deadline after an earlier competing alarm", async () => {
  assert.ok(alarmModule, "production alarm scheduling helper must be available");
  if (!alarmModule) return;

  const reconnectAt = "1970-01-01T00:00:00.000Z";
  const armed = [];
  let releaseFirstAlarm;
  let firstSettled = false;
  const firstAlarm = new Promise((resolve) => { releaseFirstAlarm = resolve; });
  const setAlarm = async (deadline) => {
    armed.push(deadline);
    if (deadline === 1_000) {
      await firstAlarm;
      firstSettled = true;
    }
  };

  const firstRearm = alarmModule.armNextAlarm({
    now: 0,
    state: "ready",
    createdAt: -120_000,
    maxTimeMs: null,
    sandboxDisconnectedAt: reconnectAt,
    presentationRetryAt: null,
    workspaceCacheRetryAt: 1_000,
  }, setAlarm);

  await Promise.resolve();
  assert.equal(firstSettled, false, "rearm must wait for setAlarm to settle");
  releaseFirstAlarm();
  await firstRearm;
  assert.deepEqual(armed, [1_000]);

  await alarmModule.armNextAlarm({
    now: 1_000,
    state: "ready",
    createdAt: -120_000,
    maxTimeMs: null,
    sandboxDisconnectedAt: reconnectAt,
    presentationRetryAt: null,
    workspaceCacheRetryAt: null,
  }, setAlarm);
  assert.deepEqual(armed, [1_000, 60_000]);
});

test("propagates a replacement alarm persistence failure", async () => {
  assert.ok(alarmModule, "production alarm scheduling helper must be available");
  if (!alarmModule) return;

  await assert.rejects(
    alarmModule.armNextAlarm({
      now: 1_000,
      state: "ready",
      createdAt: 0,
      maxTimeMs: null,
      sandboxDisconnectedAt: "1970-01-01T00:00:00.000Z",
      presentationRetryAt: null,
      workspaceCacheRetryAt: null,
    }, async () => {
      throw new Error("setAlarm failed");
    }),
    /setAlarm failed/,
  );
});

test("alarm includes idle pause and lease renewal deadlines", async () => {
  const { nextAlarmDeadline } = alarmModule;
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const base = { now: T0 + 120_000, state: "ready", createdAt: T0, maxTimeMs: null };
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: T0 + 200_000, leaseRenewAt: T0 + 300_000 }), T0 + 200_000);
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: null, leaseRenewAt: T0 + 300_000 }), T0 + 300_000);
  assert.equal(nextAlarmDeadline({ ...base, state: "failed", idlePauseAt: T0 + 200_000 }), undefined);
  assert.equal(nextAlarmDeadline({ ...base, state: "failed", leaseRenewAt: T0 + 200_000 }), undefined);
});

test("past-due idle pause and lease renewal deadlines retry after the past-due delay", async () => {
  const { nextAlarmDeadline } = alarmModule;
  const { SANDBOX_PAST_DUE_RETRY_MS } = await import("../dist/orchestrator/sandbox-lifecycle.js");
  assert.equal(SANDBOX_PAST_DUE_RETRY_MS, 30_000);
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const base = { now: T0 + 120_000, state: "ready", createdAt: T0, maxTimeMs: null };
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: T0 + 1_000 }), base.now + 30_000);
  assert.equal(nextAlarmDeadline({ ...base, leaseRenewAt: base.now }), base.now + 30_000);
  // Future deadlines beyond the retry delay are unchanged.
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: base.now + 90_000 }), base.now + 90_000);
});

test("non-finite idle pause and lease renewal deadlines are ignored", async () => {
  const { nextAlarmDeadline } = alarmModule;
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const base = { now: T0 + 120_000, state: "ready", createdAt: T0, maxTimeMs: null };
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: Number.NaN, leaseRenewAt: Number.NaN }), undefined);
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: Number.POSITIVE_INFINITY }), undefined);
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: Number.NaN, leaseRenewAt: base.now + 50_000 }), base.now + 50_000);
});

test("earlier existing deadlines still win over idle pause and lease renewal", async () => {
  const { nextAlarmDeadline } = alarmModule;
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const now = T0 + 120_000;
  assert.equal(
    nextAlarmDeadline({ now, state: "ready", createdAt: T0, maxTimeMs: 150_000, idlePauseAt: now - 1, leaseRenewAt: now + 100_000 }),
    T0 + 150_000,
  );
  const disconnectedAt = new Date(now).toISOString();
  const { sandboxReconnectDeadline } = await import("../dist/sandbox-connection.js");
  const reconnect = sandboxReconnectDeadline(disconnectedAt);
  assert.ok(reconnect > now);
  assert.equal(
    nextAlarmDeadline({
      now, state: "ready", createdAt: T0, maxTimeMs: null,
      sandboxDisconnectedAt: disconnectedAt, idlePauseAt: reconnect + 10_000, leaseRenewAt: reconnect + 20_000,
    }),
    reconnect,
  );
});
