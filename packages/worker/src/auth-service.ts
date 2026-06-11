import type { MembershipRow } from "./memberships.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export interface AuthSession {
  user: AuthenticatedUser;
}

export interface AuthMeInput {
  session: AuthSession | null;
  membership: MembershipRow | null;
  setupRequired: boolean;
  authConfigured: boolean;
}

export interface AuthMeResponse {
  authenticated: boolean;
  setupRequired: boolean;
  authConfigured: boolean;
  user?: AuthenticatedUser;
  membership?: {
    role: MembershipRow["role"];
    status: MembershipRow["status"];
  };
}

export function buildAuthMeResponse(input: AuthMeInput): AuthMeResponse {
  if (!input.session) {
    return {
      authenticated: false,
      setupRequired: input.setupRequired,
      authConfigured: input.authConfigured,
    };
  }

  return {
    authenticated: true,
    setupRequired: input.setupRequired,
    authConfigured: input.authConfigured,
    user: input.session.user,
    ...(input.membership
      ? {
          membership: {
            role: input.membership.role,
            status: input.membership.status,
          },
        }
      : {}),
  };
}

export function verifySetupToken(expected: string | undefined, provided: string): boolean {
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}
