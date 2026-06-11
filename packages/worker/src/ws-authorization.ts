import {
  AuthRoleSchema,
  can,
  type AuthAction,
  type AuthRole,
  type CLIToDOMessage,
} from "@codevil/shared";
import type { MembershipRow } from "./memberships.js";

export interface SocketAuthContext {
  userId: string;
  email: string;
  role: AuthRole;
}

export interface SocketAttachment {
  auth?: Partial<SocketAuthContext> | null;
}

interface RawSocketAuth {
  userId?: unknown;
  email?: unknown;
  role?: unknown;
}

type AuthorizationResult =
  | { ok: true; action: AuthAction; role: AuthRole }
  | { ok: false; action: AuthAction; status: 401 | 403; message: string };

export function authActionForClientMessage(message: CLIToDOMessage): AuthAction {
  switch (message.type) {
    case "approve":
    case "approve_run":
      return "runs:approve";
    case "preview_start":
      return "preview:start";
    case "human_message":
    case "agent_request":
    case "abort":
    case "abort_run":
    case "stop_session":
    case "refine_plan":
    case "refine_run":
    case "preview_stop":
      return "sessions:control";
  }
}

export function socketAuthFromRequest(request: Request): SocketAuthContext | null {
  const url = new URL(request.url);
  return normalizeSocketAuth({
    userId: url.searchParams.get("auth_user_id"),
    email: url.searchParams.get("auth_email"),
    role: url.searchParams.get("auth_role"),
  });
}

export function socketAuthFromAttachment(attachment: SocketAttachment | null | undefined): SocketAuthContext | null {
  return normalizeSocketAuth(attachment?.auth);
}

export async function authorizeSocketMessage(input: {
  auth: SocketAuthContext | null;
  message: CLIToDOMessage;
  loadMembership: (userId: string) => Promise<MembershipRow | null>;
}): Promise<AuthorizationResult> {
  const action = authActionForClientMessage(input.message);
  if (!input.auth) {
    return { ok: false, action, status: 401, message: "Unauthorized" };
  }

  const membership = await input.loadMembership(input.auth.userId);
  if (!membership) {
    return { ok: false, action, status: 403, message: "Membership required" };
  }

  if (!can(membership.role, action)) {
    return { ok: false, action, status: 403, message: "Forbidden" };
  }

  return { ok: true, action, role: membership.role };
}

function normalizeSocketAuth(value: RawSocketAuth | null | undefined): SocketAuthContext | null {
  if (!value) return null;
  if (typeof value.userId !== "string" || value.userId.length === 0) return null;
  if (typeof value.email !== "string" || value.email.length === 0) return null;

  const role = AuthRoleSchema.safeParse(value.role);
  if (!role.success) return null;

  return {
    userId: value.userId,
    email: value.email,
    role: role.data,
  };
}
