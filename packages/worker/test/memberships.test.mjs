import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  activeMembershipByUserSelect,
  createOwnerMembershipInsert,
  normalizeEmail,
  ownerExistsSelect,
  pendingInviteByEmailSelect,
} from "../dist/memberships.js";

test("normalizeEmail lowercases and trims email addresses", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM  "), "alice@example.com");
});

test("ownerExistsSelect checks for any active owner", () => {
  const query = ownerExistsSelect();

  assert.match(query.sql, /FROM memberships/i);
  assert.match(query.sql, /role = \?/i);
  assert.match(query.sql, /status = \?/i);
  assert.deepEqual(query.bindings, ["owner", "active"]);
});

test("activeMembershipByUserSelect fetches one active membership", () => {
  const query = activeMembershipByUserSelect("usr_123");

  assert.match(query.sql, /WHERE user_id = \?/i);
  assert.match(query.sql, /status = \?/i);
  assert.deepEqual(query.bindings, ["usr_123", "active"]);
});

test("createOwnerMembershipInsert atomically creates the first active owner only", () => {
  const query = createOwnerMembershipInsert("usr_123", "2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /^INSERT INTO memberships/i);
  assert.match(query.sql, /SELECT \?, \?, \?, \?, \?/i);
  assert.match(query.sql, /WHERE NOT EXISTS/i);
  assert.deepEqual(query.bindings, [
    "usr_123",
    "owner",
    "active",
    "2026-06-11T00:00:00.000Z",
    "2026-06-11T00:00:00.000Z",
    "owner",
    "active",
  ]);
});

test("racing setup claims deterministically promote one owner", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE memberships (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  const first = createOwnerMembershipInsert("usr_first", "2026-06-11T00:00:00.000Z");
  const second = createOwnerMembershipInsert("usr_second", "2026-06-11T00:00:00.001Z");
  const firstResult = db.prepare(first.sql).run(...first.bindings);
  const secondResult = db.prepare(second.sql).run(...second.bindings);

  assert.equal(firstResult.changes, 1);
  assert.equal(secondResult.changes, 0);
  assert.deepEqual(
    Array.from(db.prepare("SELECT user_id, role, status FROM memberships").all(), (row) => ({ ...row })),
    [{ user_id: "usr_first", role: "owner", status: "active" }],
  );
  db.close();
});

test("pendingInviteByEmailSelect finds active pending invites by normalized email", () => {
  const query = pendingInviteByEmailSelect("Alice@Example.COM", "2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /FROM invitations/i);
  assert.match(query.sql, /accepted_at IS NULL/i);
  assert.match(query.sql, /revoked_at IS NULL/i);
  assert.match(query.sql, /expires_at > \?/i);
  assert.deepEqual(query.bindings, ["alice@example.com", "2026-06-11T00:00:00.000Z"]);
});
