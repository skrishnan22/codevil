import { z } from "zod";

export const AuthRoleSchema = z.enum(["owner", "admin", "developer", "viewer"]);

export const AuthActionSchema = z.enum([
  "members:invite",
  "members:invite-owner",
  "members:manage",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "runs:approve",
  "preview:start",
]);

export type AuthRole = z.infer<typeof AuthRoleSchema>;
export type AuthAction = z.infer<typeof AuthActionSchema>;

const POLICY: Record<AuthRole, ReadonlySet<AuthAction>> = {
  owner: new Set([
    "members:invite",
    "members:invite-owner",
    "members:manage",
    "sessions:create",
    "sessions:read",
    "sessions:control",
    "runs:approve",
    "preview:start",
  ]),
  admin: new Set([
    "members:invite",
    "members:manage",
    "sessions:create",
    "sessions:read",
    "sessions:control",
    "runs:approve",
    "preview:start",
  ]),
  developer: new Set([
    "sessions:create",
    "sessions:read",
    "sessions:control",
    "runs:approve",
    "preview:start",
  ]),
  viewer: new Set(["sessions:read"]),
};

export function can(role: AuthRole, action: AuthAction): boolean {
  return POLICY[role].has(action);
}
