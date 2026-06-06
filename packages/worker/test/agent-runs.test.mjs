import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAgentRun,
  enqueueAgentRun,
  finishActiveAgentRun,
} from "../dist/agent-runs.js";

const actor = { id: "usr_123", name: "Alice" };

test("enqueueAgentRun starts immediately when no run is active", () => {
  const run = createAgentRun({ actor, text: "fix bug", now: "2026-06-03T00:00:00.000Z" });
  const next = enqueueAgentRun({ active: null, queue: [] }, run);

  assert.equal(next.active?.id, run.id);
  assert.equal(next.active?.state, "thinking");
  assert.equal(next.started?.id, run.id);
  assert.equal(next.queued, undefined);
  assert.equal(next.queue.length, 0);
});

test("enqueueAgentRun queues behind an active run", () => {
  const active = createAgentRun({ actor, text: "first", now: "2026-06-03T00:00:00.000Z" });
  const queued = createAgentRun({ actor, text: "second", now: "2026-06-03T00:00:01.000Z" });
  const next = enqueueAgentRun({ active, queue: [] }, queued);

  assert.equal(next.active?.id, active.id);
  assert.equal(next.queued?.position, 1);
  assert.equal(next.queue[0].id, queued.id);
});

test("finishActiveAgentRun promotes the next queued run", () => {
  const active = createAgentRun({ actor, text: "first", now: "2026-06-03T00:00:00.000Z" });
  const queued = createAgentRun({ actor, text: "second", now: "2026-06-03T00:00:01.000Z" });
  const next = finishActiveAgentRun({ active, queue: [queued] });

  assert.equal(next.active?.id, queued.id);
  assert.equal(next.active?.state, "thinking");
  assert.equal(next.started?.id, queued.id);
  assert.equal(next.queue.length, 0);
});
