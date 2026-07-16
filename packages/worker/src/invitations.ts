import { can, type AuthRole } from "@codevil/shared";
import { normalizeEmail, type InvitationRow } from "./memberships.js";
import type { SqlStatement } from "./sql.js";

export const INVITATION_TTL_DAYS = 14;

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export function createInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `inv_${base64Url(bytes)}`;
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inviteExpiresAt(now: Date, ttlDays = INVITATION_TTL_DAYS): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export function canInviteRole(inviterRole: AuthRole, inviteRole: AuthRole): boolean {
  if (!can(inviterRole, "members:invite")) return false;
  return inviteRole !== "owner" || can(inviterRole, "members:invite-owner");
}

export function inviteStatus(invitation: InvitationRow, now: string): InvitationStatus {
  if (invitation.accepted_at) return "accepted";
  if (invitation.revoked_at) return "revoked";
  if (invitation.expires_at <= now) return "expired";
  return "pending";
}

export function membershipByUserSelect(userId: string): SqlStatement {
  return {
    sql: "SELECT * FROM memberships WHERE user_id = ? LIMIT 1",
    bindings: [userId],
  };
}

export function membershipByEmailSelect(email: string): SqlStatement {
  return {
    sql: `SELECT m.*
      FROM memberships m
      JOIN "user" u ON u.id = m.user_id
      WHERE lower(u.email) = ?
      LIMIT 1`,
    bindings: [normalizeEmail(email)],
  };
}

export function listPendingInvitationsSelect(now: string): SqlStatement {
  return {
    sql: `SELECT *
      FROM invitations
      WHERE accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?
      ORDER BY created_at DESC`,
    bindings: [now],
  };
}

export function invitationByIdSelect(id: string): SqlStatement {
  return {
    sql: "SELECT * FROM invitations WHERE id = ? LIMIT 1",
    bindings: [id],
  };
}

export function invitationByTokenHashSelect(tokenHash: string): SqlStatement {
  return {
    sql: "SELECT * FROM invitations WHERE token_hash = ? LIMIT 1",
    bindings: [tokenHash],
  };
}

export function createInvitationInsert(row: InvitationRow): SqlStatement {
  return {
    sql: `INSERT INTO invitations (
      id,
      email,
      role,
      token_hash,
      invited_by_user_id,
      expires_at,
      accepted_at,
      revoked_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      row.id,
      normalizeEmail(row.email),
      row.role,
      row.token_hash,
      row.invited_by_user_id,
      row.expires_at,
      row.accepted_at ?? null,
      row.revoked_at ?? null,
      row.created_at,
      row.updated_at,
    ],
  };
}

export function createMembershipFromInviteInsert(
  userId: string,
  tokenHash: string,
  email: string,
  now: string,
): SqlStatement {
  return {
    sql: `INSERT INTO memberships (
      user_id,
      role,
      status,
      created_at,
      updated_at
    )
    SELECT ?, role, ?, ?, ?
      FROM invitations
      WHERE token_hash = ?
        AND email = ?
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?
      LIMIT 1`,
    bindings: [userId, "active", now, now, tokenHash, normalizeEmail(email), now],
  };
}

export function acceptInvitationUpdate(id: string, now: string): SqlStatement {
  return {
    sql: `UPDATE invitations
      SET accepted_at = ?,
          updated_at = ?
      WHERE id = ?
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?`,
    bindings: [now, now, id, now],
  };
}

export function revokeInvitationUpdate(id: string, now: string): SqlStatement {
  return {
    sql: `UPDATE invitations
      SET revoked_at = ?,
          updated_at = ?
      WHERE id = ?
        AND accepted_at IS NULL
        AND revoked_at IS NULL`,
    bindings: [now, now, id],
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
