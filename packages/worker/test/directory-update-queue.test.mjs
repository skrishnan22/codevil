import assert from "node:assert/strict";
import test from "node:test";

import { DirectoryUpdateQueue } from "../dist/orchestrator/directory-update-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("DirectoryUpdateQueue preserves mutation order when an earlier write is delayed", async () => {
  const queue = new DirectoryUpdateQueue();
  const first = deferred();
  const calls = [];

  const firstWrite = queue.enqueue(async () => {
    calls.push("first:start");
    await first.promise;
    calls.push("first:end");
  });
  const secondWrite = queue.enqueue(async () => {
    calls.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["first:start"]);
  first.resolve();
  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(calls, ["first:start", "first:end", "second"]);
});

test("DirectoryUpdateQueue continues after a failed best-effort write", async () => {
  const queue = new DirectoryUpdateQueue();
  const calls = [];

  await assert.rejects(queue.enqueue(async () => {
    calls.push("failed");
    throw new Error("transient D1 failure");
  }));
  await queue.enqueue(async () => { calls.push("recovered"); });

  assert.deepEqual(calls, ["failed", "recovered"]);
});

test("DirectoryUpdateQueue coalesces a burst to the latest pending keyed update", async () => {
  const queue = new DirectoryUpdateQueue({ maxPending: 1 });
  const gate = deferred();
  const calls = [];

  const active = queue.enqueue(async () => {
    calls.push("active:start");
    await gate.promise;
    calls.push("active:end");
  });

  await Promise.resolve();
  const updates = Array.from({ length: 100 }, (_, index) => queue.enqueue(async () => {
    calls.push(`update:${index}`);
  }, { key: "session" }));

  // The active write is separate; all queued updates share one bounded slot.
  assert.equal(queue.pendingCount, 1);
  gate.resolve();
  await Promise.all([active, ...updates]);
  await delay(0);

  assert.deepEqual(calls, ["active:start", "active:end", "update:99"]);
});
