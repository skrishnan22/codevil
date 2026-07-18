import type { AuthRole } from "@codevil/shared";
import type { SqlStatement } from "./sql.js";

export interface MembershipRow {
  user_id: string;
  role: AuthRole;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: AuthRole;
  token_hash: string;
  invited_by_user_id: string;
  expires_at: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function ownerExistsSelect(): SqlStatement {
  return {
    sql: "SELECT 1 FROM memberships WHERE role = ? AND status = ? LIMIT 1",
    bindings: ["owner", "active"],
  };
}

export function activeMembershipByUserSelect(userId: string): SqlStatement {
  return {
    sql: "SELECT * FROM memberships WHERE user_id = ? AND status = ? LIMIT 1",
    bindings: [userId, "active"],
  };
}

export function createOwnerMembershipInsert(userId: string, now: string): SqlStatement {
  return {
    // This is deliberately one conditional statement rather than a
    // SELECT-then-INSERT sequence. Setup is a one-time privilege boundary,
    // and concurrent D1 requests must not be able to observe "no owner" and
    // both promote themselves.
    sql: `INSERT INTO memberships (
      user_id,
      role,
      status,
      created_at,
      updated_at
    ) SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM memberships WHERE role = ? AND status = ?
      )`,
    bindings: [userId, "owner", "active", now, now, "owner", "active"],
  };
}

export function pendingInviteByEmailSelect(email: string, now: string): SqlStatement {
  return {
    sql: `SELECT * FROM invitations
      WHERE email = ?
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?
      LIMIT 1`,
    bindings: [normalizeEmail(email), now],
  };
}
