import type { AuthMeResponse, GetInviteResponse } from "./api-client";

interface InviteAutoAcceptState {
  invite: GetInviteResponse | null;
  auth: AuthMeResponse | null;
  accepting: boolean;
  accepted: boolean;
  autoAcceptAttempted: boolean;
}

export function shouldAutoAcceptInvite(state: InviteAutoAcceptState): boolean {
  if (state.accepting || state.accepted || state.autoAcceptAttempted) return false;
  if (state.invite?.status !== "pending") return false;
  if (!state.auth?.authenticated) return false;
  if (state.auth.membership) return false;
  return true;
}
