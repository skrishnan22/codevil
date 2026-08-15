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
