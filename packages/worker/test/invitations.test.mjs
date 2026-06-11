import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptInvitationUpdate,
  canInviteRole,
  createInviteToken,
  createMembershipFromInviteInsert,
  hashInviteToken,
  inviteStatus,
  invitationByTokenHashSelect,
  inviteExpiresAt,
  listPendingInvitationsSelect,
  membershipByEmailSelect,
  membershipByUserSelect,
  revokeInvitationUpdate,
} from "../dist/invitations.js";

test("createInviteToken returns a non-guessable URL-safe token", () => {
  const token = createInviteToken();

  assert.match(token, /^inv_[A-Za-z0-9_-]{43}$/);
});

test("hashInviteToken hashes the raw invite token without storing it", async () => {
  const hash = await hashInviteToken("inv_test_token");

  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]+$/);
  assert.notEqual(hash, "inv_test_token");
});

test("inviteExpiresAt defaults to fourteen days after creation", () => {
  assert.equal(
    inviteExpiresAt(new Date("2026-06-11T00:00:00.000Z")),
    "2026-06-25T00:00:00.000Z",
  );
});

test("canInviteRole allows admins to invite non-owner roles only", () => {
  assert.equal(canInviteRole("admin", "developer"), true);
  assert.equal(canInviteRole("admin", "viewer"), true);
  assert.equal(canInviteRole("admin", "owner"), false);
});

test("canInviteRole allows owners to invite owners", () => {
  assert.equal(canInviteRole("owner", "owner"), true);
});

test("inviteStatus classifies token state without mutating it", () => {
  const pending = {
    id: "inv_1",
    email: "alice@example.com",
    role: "developer",
    token_hash: "hash",
    invited_by_user_id: "usr_owner",
    expires_at: "2026-06-12T00:00:00.000Z",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
  };

  assert.equal(inviteStatus(pending, "2026-06-11T00:00:00.000Z"), "pending");
  assert.equal(inviteStatus({ ...pending, accepted_at: "2026-06-11T01:00:00.000Z" }, "2026-06-11T00:00:00.000Z"), "accepted");
  assert.equal(inviteStatus({ ...pending, revoked_at: "2026-06-11T01:00:00.000Z" }, "2026-06-11T00:00:00.000Z"), "revoked");
  assert.equal(inviteStatus(pending, "2026-06-13T00:00:00.000Z"), "expired");
});

test("membershipByEmailSelect checks Better Auth users by normalized email", () => {
  const query = membershipByEmailSelect(" Alice@Example.COM ");

  assert.match(query.sql, /JOIN "user"/i);
  assert.match(query.sql, /lower\(u\.email\) = \?/i);
  assert.deepEqual(query.bindings, ["alice@example.com"]);
});

test("membershipByUserSelect fetches active or disabled membership", () => {
  const query = membershipByUserSelect("usr_123");

  assert.match(query.sql, /FROM memberships/i);
  assert.match(query.sql, /WHERE user_id = \?/i);
  assert.doesNotMatch(query.sql, /status = \?/i);
  assert.deepEqual(query.bindings, ["usr_123"]);
});

test("invitationByTokenHashSelect fetches invite state without filtering it", () => {
  const query = invitationByTokenHashSelect("abc123");

  assert.match(query.sql, /FROM invitations/i);
  assert.match(query.sql, /token_hash = \?/i);
  assert.doesNotMatch(query.sql, /accepted_at IS NULL/i);
  assert.deepEqual(query.bindings, ["abc123"]);
});

test("listPendingInvitationsSelect lists only unconsumed unexpired invites", () => {
  const query = listPendingInvitationsSelect("2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /accepted_at IS NULL/i);
  assert.match(query.sql, /revoked_at IS NULL/i);
  assert.match(query.sql, /expires_at > \?/i);
  assert.deepEqual(query.bindings, ["2026-06-11T00:00:00.000Z"]);
});

test("createMembershipFromInviteInsert gates membership creation on the pending token and matching email", () => {
  const query = createMembershipFromInviteInsert(
    "usr_123",
    "hash",
    "alice@example.com",
    "2026-06-11T00:00:00.000Z",
  );

  assert.match(query.sql, /^INSERT INTO memberships/i);
  assert.match(query.sql, /SELECT \?, role, \?, \?, \?/i);
  assert.match(query.sql, /token_hash = \?/i);
  assert.match(query.sql, /email = \?/i);
  assert.match(query.sql, /accepted_at IS NULL/i);
  assert.match(query.sql, /revoked_at IS NULL/i);
  assert.deepEqual(query.bindings, [
    "usr_123",
    "active",
    "2026-06-11T00:00:00.000Z",
    "2026-06-11T00:00:00.000Z",
    "hash",
    "alice@example.com",
    "2026-06-11T00:00:00.000Z",
  ]);
});

test("acceptInvitationUpdate consumes only a still-pending invite", () => {
  const query = acceptInvitationUpdate("inv_1", "2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /^UPDATE invitations/i);
  assert.match(query.sql, /accepted_at = \?/i);
  assert.match(query.sql, /accepted_at IS NULL/i);
  assert.match(query.sql, /revoked_at IS NULL/i);
  assert.match(query.sql, /expires_at > \?/i);
  assert.deepEqual(query.bindings, [
    "2026-06-11T00:00:00.000Z",
    "2026-06-11T00:00:00.000Z",
    "inv_1",
    "2026-06-11T00:00:00.000Z",
  ]);
});

test("revokeInvitationUpdate revokes only a still-pending invite", () => {
  const query = revokeInvitationUpdate("inv_1", "2026-06-11T00:00:00.000Z");

  assert.match(query.sql, /^UPDATE invitations/i);
  assert.match(query.sql, /revoked_at = \?/i);
  assert.match(query.sql, /accepted_at IS NULL/i);
  assert.match(query.sql, /revoked_at IS NULL/i);
  assert.deepEqual(query.bindings, [
    "2026-06-11T00:00:00.000Z",
    "2026-06-11T00:00:00.000Z",
    "inv_1",
  ]);
});
