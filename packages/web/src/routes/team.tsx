import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { loadConfig } from "@/lib/config";
import {
  createInvitation,
  getAuthMe,
  listInvitations,
  revokeInvitation,
  type AuthMeResponse,
  type InvitationRole,
  type InvitationSummary,
} from "@/lib/api-client";

export const Route = createFileRoute("/team")({
  component: TeamPage,
});

const INVITE_ROLES: InvitationRole[] = ["admin", "developer", "viewer"];

function canManageInvites(auth: AuthMeResponse | null): boolean {
  const role = auth?.membership?.role;
  return role === "owner" || role === "admin";
}

function TeamPage() {
  const [authState, setAuthState] = useState<AuthMeResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("developer");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    const config = loadConfig();
    if (!config) {
      setAuthLoading(false);
      return;
    }
    try {
      const auth = await getAuthMe(config);
      setAuthState(auth);
      if (canManageInvites(auth)) {
        await refreshInvitations();
      }
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthLoading(false);
    }
  }

  async function refreshInvitations() {
    const config = loadConfig();
    if (!config) return;
    try {
      const result = await listInvitations(config);
      setInvitations(result.invitations);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateInvite(e: React.FormEvent) {
    e.preventDefault();
    const config = loadConfig();
    if (!config) {
      setInviteError("Configure your backend URL in Settings first.");
      return;
    }

    setInviteLoading(true);
    setInviteError(null);
    setInviteMessage(null);
    setLastInviteUrl(null);
    try {
      const result = await createInvitation(config, { email: inviteEmail.trim(), role: inviteRole });
      if (result.status === "created") {
        setInviteEmail("");
        setLastInviteUrl(result.invite_url ?? null);
        if (result.email_delivery?.status === "sent") {
          setInviteMessage("Invite email sent.");
        } else if (result.email_delivery?.status === "failed") {
          setInviteMessage(`Invite created, but email failed: ${result.email_delivery.error}`);
        } else {
          setInviteMessage("Invite created. Email is not configured, copy the link below.");
        }
        await refreshInvitations();
      } else if (result.status === "already_invited") {
        setInviteMessage("That email already has a pending invite.");
      } else if (result.status === "already_member") {
        setInviteMessage("That email already belongs to a team member.");
      } else {
        setInviteMessage("That member is disabled and cannot be invited.");
      }
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleRevokeInvite(invitationId: string) {
    const config = loadConfig();
    if (!config) return;

    setInviteError(null);
    setInviteMessage(null);
    try {
      await revokeInvitation(config, invitationId);
      setInviteMessage("Invite revoked.");
      await refreshInvitations();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    }
  }

  const inviteRoleOptions = authState?.membership?.role === "owner"
    ? (["owner", ...INVITE_ROLES] as InvitationRole[])
    : INVITE_ROLES;

  if (authLoading) {
    return (
      <main className="home-page">
        <div className="home-page-inner">
          <section className="home-hero">
            <div className="home-eyebrow">Team</div>
            <h1 className="home-hero-title">Loading</h1>
          </section>
        </div>
      </main>
    );
  }

  if (!canManageInvites(authState)) {
    return (
      <main className="home-page">
        <div className="home-page-inner">
          <section className="home-hero">
            <div className="home-eyebrow">Team</div>
            <h1 className="home-hero-title">Manage your team</h1>
            <p className="home-hero-sub">You don't have access to manage the team.</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="home-page">
      <div className="home-page-inner">
        <section className="home-hero">
          <div className="home-eyebrow">Team</div>
          <h1 className="home-hero-title">Manage your team</h1>
          <p className="home-hero-sub">
            Invite teammates and manage pending invitations to this Codevil instance.
          </p>
        </section>

        <section className="home-team" aria-labelledby="team-invites-title">
          <div className="home-sessions-head">
            <h2 id="team-invites-title">Team invites</h2>
          </div>
          <form className="home-team-invite" onSubmit={handleCreateInvite}>
            <label className="home-launcher-field">
              <span>Email</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="alice@example.com"
                required
              />
            </label>
            <label className="home-launcher-field">
              <span>Role</span>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as InvitationRole)}>
                {inviteRoleOptions.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="home-launcher-create" disabled={!inviteEmail.trim() || inviteLoading}>
              {inviteLoading ? "Inviting…" : "Invite"}
            </button>
          </form>
          {lastInviteUrl && (
            <div className="home-team-link">
              <input value={lastInviteUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}
          {inviteMessage && <p className="home-team-note">{inviteMessage}</p>}
          {inviteError && <p className="home-error">{inviteError}</p>}
          {invitations.length > 0 && (
            <div className="home-team-list">
              {invitations.map((invitation) => (
                <div key={invitation.id} className="home-team-row">
                  <span>
                    <strong>{invitation.email}</strong>
                    <span>{invitation.role}</span>
                  </span>
                  <button type="button" onClick={() => void handleRevokeInvite(invitation.id)}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="home-team">
          <div className="home-sessions-head">
            <h2>Active members</h2>
          </div>
          <p className="home-team-note">Member listing will appear here once the API is wired up.</p>
        </section>
      </div>
    </main>
  );
}
