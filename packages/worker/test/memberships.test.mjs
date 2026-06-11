import assert from "node:assert/strict";
import test from "node:test";

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

test("createOwnerMembershipInsert creates an active owner membership", () => {
  const query = createOwnerMembershipInsert("usr_123", "2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /^INSERT INTO memberships/i);
  assert.deepEqual(query.bindings, [
    "usr_123",
    "owner",
    "active",
    "2026-06-11T00:00:00.000Z",
    "2026-06-11T00:00:00.000Z",
  ]);
});

test("pendingInviteByEmailSelect finds active pending invites by normalized email", () => {
  const query = pendingInviteByEmailSelect("Alice@Example.COM", "2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /FROM invitations/i);
  assert.match(query.sql, /accepted_at IS NULL/i);
  assert.match(query.sql, /revoked_at IS NULL/i);
  assert.match(query.sql, /expires_at > \?/i);
  assert.deepEqual(query.bindings, ["alice@example.com", "2026-06-11T00:00:00.000Z"]);
});
