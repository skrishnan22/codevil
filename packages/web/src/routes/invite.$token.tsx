import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  acceptInvite,
  getAuthMe,
  getInvite,
  signInWithGoogle,
  type AuthMeResponse,
  type GetInviteResponse,
} from "@/lib/api-client";
import { loadConfig } from "@/lib/config";

export const Route = createFileRoute("/invite/$token")({
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useParams();
  const [invite, setInvite] = useState<GetInviteResponse | null>(null);
  const [auth, setAuth] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadInvite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function loadInvite() {
    const config = loadConfig();
    if (!config) {
      setError("Configure your backend URL in Settings before accepting this invite.");
      setLoading(false);
      return;
    }

    try {
      const [inviteResult, authResult] = await Promise.all([
        getInvite(config, token),
        getAuthMe(config),
      ]);
      setInvite(inviteResult);
      setAuth(authResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignIn() {
    const config = loadConfig();
    if (!config) {
      setError("Configure your backend URL in Settings before signing in.");
      return;
    }

    try {
      const result = await signInWithGoogle(config, window.location.href);
      window.location.assign(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAccept() {
    const config = loadConfig();
    if (!config) return;

    setAccepting(true);
    setError(null);
    try {
      await acceptInvite(config, token);
      setMessage("Invite accepted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting(false);
    }
  }

  if (loading) {
    return <InviteShell title="Loading invite" />;
  }

  if (error && !invite) {
    return <InviteShell title="Invite unavailable" copy={error} />;
  }

  if (!invite || invite.status === "invalid") {
    return <InviteShell title="Invite unavailable" copy="This invite link is invalid." />;
  }

  if (invite.status !== "pending") {
    return <InviteShell title="Invite unavailable" copy={`This invite is ${invite.status}.`} />;
  }

  if (message) {
    return (
      <InviteShell title="Invite accepted" copy="You can now open Codevil.">
        <Link to="/" className="home-launcher-create">Open Codevil</Link>
      </InviteShell>
    );
  }

  return (
    <InviteShell
      title="Join Codevil"
      copy={`You were invited as ${invite.invitation?.role ?? "a member"} at ${invite.invitation?.email ?? "this email"}.`}
    >
      {!auth?.authenticated ? (
        <div className="home-launcher-foot">
          <span className="home-launcher-hint">Google OAuth</span>
          <button type="button" className="home-launcher-create" onClick={handleSignIn}>
            Continue with Google
            <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : (
        <div className="home-launcher-foot">
          <span className="home-launcher-hint">{auth.user?.email}</span>
          <button type="button" className="home-launcher-create" onClick={handleAccept} disabled={accepting}>
            {accepting ? "Accepting…" : "Accept invite"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      )}
      {error && <p className="home-error">{error}</p>}
    </InviteShell>
  );
}

function InviteShell({ title, copy, children }: {
  title: string;
  copy?: string;
  children?: ReactNode;
}) {
  return (
    <main className="home-page">
      <div className="home-page-inner">
        <section className="home-hero">
          <div className="home-eyebrow">Codevil invite</div>
          <h1 className="home-hero-title">{title}</h1>
          {copy && <p className="home-hero-sub">{copy}</p>}
        </section>
        {children}
      </div>
    </main>
  );
}
