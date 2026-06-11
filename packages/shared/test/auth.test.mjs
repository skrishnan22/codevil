import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthRoleSchema,
  can,
} from "../dist/auth.js";

test("AuthRoleSchema accepts fixed v1 roles", () => {
  assert.equal(AuthRoleSchema.parse("owner"), "owner");
  assert.equal(AuthRoleSchema.parse("admin"), "admin");
  assert.equal(AuthRoleSchema.parse("developer"), "developer");
  assert.equal(AuthRoleSchema.parse("viewer"), "viewer");
});

test("AuthRoleSchema rejects custom roles", () => {
  assert.throws(() => AuthRoleSchema.parse("maintainer"));
});

test("owners can invite owners and manage members", () => {
  assert.equal(can("owner", "members:invite"), true);
  assert.equal(can("owner", "members:invite-owner"), true);
  assert.equal(can("owner", "members:manage"), true);
});

test("admins can invite members but not owners", () => {
  assert.equal(can("admin", "members:invite"), true);
  assert.equal(can("admin", "members:invite-owner"), false);
});

test("developers can create and control sessions but cannot manage members", () => {
  assert.equal(can("developer", "sessions:create"), true);
  assert.equal(can("developer", "sessions:control"), true);
  assert.equal(can("developer", "members:invite"), false);
});

test("viewers can read sessions but cannot control runs", () => {
  assert.equal(can("viewer", "sessions:read"), true);
  assert.equal(can("viewer", "sessions:control"), false);
  assert.equal(can("viewer", "runs:approve"), false);
});
