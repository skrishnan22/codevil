import assert from "node:assert/strict";
import test from "node:test";

import {
  CreateInvitationRequestSchema,
  SetupClaimRequestSchema,
} from "../dist/http-schemas.js";

test("SetupClaimRequestSchema requires setupToken", () => {
  const parsed = SetupClaimRequestSchema.parse({ setupToken: "secret" });
  assert.equal(parsed.setupToken, "secret");
});

test("CreateInvitationRequestSchema validates email and role", () => {
  const parsed = CreateInvitationRequestSchema.parse({
    email: "dev@example.com",
    role: "developer",
  });
  assert.equal(parsed.email, "dev@example.com");
  assert.equal(parsed.role, "developer");
});

test("CreateInvitationRequestSchema rejects invalid email", () => {
  const result = CreateInvitationRequestSchema.safeParse({
    email: "not-an-email",
    role: "viewer",
  });
  assert.equal(result.success, false);
});
