import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventLog } from "../dist/orchestrator/event-log.js";

test("appendAndBroadcast returns the durable event cursor", () => {
  const sql = fakeSql(42);
  const log = new SessionEventLog(sql, () => [], () => {}, [], () => null, new Set());

  const cursor = log.appendAndBroadcast({ type: "status", message: "Working" });

  assert.equal(cursor, 42);
});

test("appendAndBroadcast returns null when validation rejects the event", () => {
  const sql = fakeSql(42);
  const log = new SessionEventLog(sql, () => [], () => {}, [], () => null, new Set());

  const cursor = log.appendAndBroadcast({ type: "not_a_real_event" });

  assert.equal(cursor, null);
  assert.equal(sql.inserts, 0);
});

function fakeSql(cursor) {
  return {
    inserts: 0,
    exec(query) {
      if (query.startsWith("INSERT INTO events")) this.inserts += 1;
      if (query.startsWith("SELECT id FROM events")) {
        return { one: () => ({ id: cursor }) };
      }
      return { one: () => undefined, [Symbol.iterator]: function* () {} };
    },
  };
}
