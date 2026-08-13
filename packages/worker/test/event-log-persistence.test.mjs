import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventLog } from "../dist/orchestrator/event-log.js";

function rows(items) {
  return Object.assign(items, {
    one() { return items[0]; },
    toArray() { return items; },
  });
}

function createEventSql({ strictSnapshotRead = false } = {}) {
  const events = [];
  let snapshot;
  const calls = [];
  return {
    events,
    calls,
    get snapshot() { return snapshot; },
    exec(query, ...params) {
      calls.push({ query, params });
      if (query.startsWith("INSERT INTO events")) {
        events.push({ id: events.length + 1, event_json: params[0] });
        return rows([]);
      }
      if (query.includes("SELECT id FROM events ORDER BY id DESC")) return rows([{ id: events.at(-1).id }]);
      if (query.includes("SELECT COUNT(*) AS count FROM events")) {
        return rows([{ count: events.filter((event) => event.id > (params[0] ?? 0)).length }]);
      }
      if (query.startsWith("INSERT OR REPLACE INTO snapshots")) {
        snapshot = { cursor: params[1], state_json: params[2] };
        return rows([]);
      }
      if (query.includes("SELECT cursor, state_json FROM snapshots")) {
        const snapshotRows = snapshot ? [snapshot] : [];
        return strictSnapshotRead ? strictRows(snapshotRows) : rows(snapshotRows);
      }
      if (query.includes("SELECT id, event_json FROM events WHERE id >")) {
        return rows(events.filter((event) => event.id > params[0]));
      }
      return rows([]);
    },
  };
}

function strictRows(items) {
  return Object.assign(items, {
    one() {
      if (items.length === 0) throw new Error("Expected exactly one result from SQL query, but got no results.");
      return items[0];
    },
    toArray() { return items; },
  });
}

function createLog(sql) {
  return new SessionEventLog(sql, () => [], () => {}, [], () => null, new Set());
}

test("checkpointed display history keeps the canonical event history for hydrate and tail replay", () => {
  const sql = createEventSql();
  const log = createLog(sql);

  for (let index = 0; index < 1_001; index++) {
    log.appendAndBroadcast({ type: "status", message: `event ${index}` });
  }

  assert.equal(log.getSnapshotCursor(), 1_001);
  assert.equal(sql.snapshot.cursor, 1_000, "the automatic checkpoint precedes the uncheckpointed tail");
  assert.equal(sql.events.length, 1_001, "checkpointing must not erase canonical history");

  const hydrated = createLog(sql);
  hydrated.hydrateFromSql();
  assert.equal(hydrated.getSnapshotCursor(), 1_000);

  const sent = [];
  hydrated.replayEvents({ send: (frame) => sent.push(JSON.parse(frame)) }, 1_000);
  assert.deepEqual(sent[0].events.map((event) => event.cursor), [1_001]);
});

test("oversized structural state does not advance a checkpoint or delete its replay tail", () => {
  const sql = createEventSql();
  const log = createLog(sql);
  log.appendAndBroadcast({ type: "status", message: "still replayable" });

  log.snapshot = {
    ...log.snapshot,
    cursor: 1,
    planRevision: {
      runId: "run_1", round: 1, markdown: "x".repeat(1024 * 1024), locked: true, createdAt: null, revisionId: null,
    },
  };
  log.snapshotCursor = 1;
  log.persistSnapshot();

  assert.equal(sql.snapshot, undefined);
  assert.equal(sql.events.length, 1);
  assert.equal(log.getSnapshotCursor(), 0, "reconnect falls back to the prior durable checkpoint");
});

test("event tail count is hydrated once instead of queried on every append", () => {
  const sql = createEventSql();
  const log = createLog(sql);
  log.hydrateFromSql();

  for (let index = 0; index < 3; index++) {
    log.appendAndBroadcast({ type: "status", message: `event ${index}` });
  }

  const countQueries = sql.calls.filter(({ query }) => query.includes("SELECT COUNT(*) AS count FROM events"));
  assert.equal(countQueries.length, 1);
});

test("fresh session hydration tolerates a missing snapshot checkpoint", () => {
  const sql = createEventSql({ strictSnapshotRead: true });
  const log = createLog(sql);

  assert.doesNotThrow(() => log.hydrateFromSql());
});
