import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { loadConfig } from "@/lib/config";
import {
  claimSetup,
  createSession,
  getAuthMe,
  listProviderModels,
  listSessions,
  signInWithGoogle,
  signOut,
  type AuthMeResponse,
} from "@/lib/api-client";
import { DEFAULT_CONFIG, LLM_PROVIDERS, PROVIDERS_WITH_MODEL_CATALOG } from "@codevil/shared";
import type { ProviderModelOption } from "@codevil/shared";
import type { SessionSummary } from "@/types";
import {
  assignParticipantAvatarColors,
  getParticipantColorKey,
} from "@/lib/avatar-colors";
import type { CSSProperties } from "react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const MODEL_PREFS_KEY = "codevil_model_prefs";

const SUPPORTED_PROVIDERS = LLM_PROVIDERS.filter((entry) =>
  PROVIDERS_WITH_MODEL_CATALOG.includes(entry.id),
);

const SUPPORTED_PROVIDER_IDS = new Set(SUPPORTED_PROVIDERS.map((entry) => entry.id));

interface ModelPrefs {
  provider: string;
  planModel: string;
  execModel: string;
}

function loadModelPrefs(): ModelPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_PREFS_KEY) ?? "{}");
    const provider = typeof parsed.provider === "string" && SUPPORTED_PROVIDER_IDS.has(parsed.provider)
      ? parsed.provider
      : DEFAULT_CONFIG.provider;
    return {
      provider,
      planModel: typeof parsed.planModel === "string" ? parsed.planModel : DEFAULT_CONFIG.plan_model,
      execModel: typeof parsed.execModel === "string" ? parsed.execModel : DEFAULT_CONFIG.exec_model,
    };
  } catch {
    return {
      provider: DEFAULT_CONFIG.provider,
      planModel: DEFAULT_CONFIG.plan_model,
      execModel: DEFAULT_CONFIG.exec_model,
    };
  }
}

function saveModelPrefs(prefs: ModelPrefs): void {
  localStorage.setItem(MODEL_PREFS_KEY, JSON.stringify(prefs));
}

type SessionStatus = "running" | "review" | "done" | "failed" | "idle";

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  review: "Review",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

function deriveStatus(session: SessionSummary): SessionStatus {
  if (session.room_state === "failed" || session.sandbox_state === "failed") return "failed";
  switch (session.active_run_state) {
    case "completed":
      return "done";
    case "awaiting_approval":
    case "verifying":
    case "publishing":
      return "review";
    case "queued":
    case "thinking":
    case "executing":
      return "running";
    case "failed":
      return "failed";
    default:
      break;
  }
  if (["provisioning", "cloning", "not_started"].includes(session.sandbox_state)) return "running";
  return "idle";
}

const FILTERS = ["all", "running", "review", "done"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  running: "Running",
  review: "Review",
  done: "Done",
};

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function GithubGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState(DEFAULT_CONFIG.provider);
  const [planModel, setPlanModel] = useState(DEFAULT_CONFIG.plan_model);
  const [execModel, setExecModel] = useState(DEFAULT_CONFIG.exec_model);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [authState, setAuthState] = useState<AuthMeResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const [setupSubmitting, setSetupSubmitting] = useState(false);
  const [modelOptions, setModelOptions] = useState<ProviderModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    const prefs = loadModelPrefs();
    setProvider(prefs.provider);
    setPlanModel(prefs.planModel);
    setExecModel(prefs.execModel);
    void refreshHome();
  }, []);

  useEffect(() => {
    const config = loadConfig();
    if (!config || !authState?.membership || authState.membership.status !== "active") {
      return;
    }

    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);

    void listProviderModels(config, provider)
      .then((result) => {
        if (cancelled) return;
        setModelOptions(result.models);
      })
      .catch((err) => {
        if (cancelled) return;
        setModelOptions([]);
        setModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [provider, authState?.membership]);

  useEffect(() => {
    if (modelOptions.length === 0) return;

    const ids = new Set(modelOptions.map((model) => model.id));
    const fallbackPlan = modelOptions.find((model) => model.id === DEFAULT_CONFIG.plan_model)?.id
      ?? modelOptions[0].id;
    const fallbackExec = modelOptions.find((model) => model.id === DEFAULT_CONFIG.exec_model)?.id
      ?? modelOptions[0].id;

    if (!ids.has(planModel)) setPlanModel(fallbackPlan);
    if (!ids.has(execModel)) setExecModel(fallbackExec);
  }, [modelOptions, planModel, execModel]);

  async function refreshHome() {
    const config = loadConfig();
    if (!config) {
      setAuthLoading(false);
      return;
    }

    try {
      const auth = await getAuthMe(config);
      setAuthState(auth);
      if (auth.authenticated && auth.membership?.status === "active") {
        await refreshSessions();
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthLoading(false);
    }
  }

  async function refreshSessions() {
    const config = loadConfig();
    if (!config) return;
    try {
      const result = await listSessions(config);
      setSessions(result.sessions);
    } catch {
      /* The create form already surfaces config/API errors. */
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const config = loadConfig();
    if (!config) {
      setError("Configure your backend URL and API key in Settings first.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const modelPrefs = { provider, planModel, execModel };
      saveModelPrefs(modelPrefs);
      const session = await createSession(config, { repo, ...modelPrefs });
      setSessions((current) => [session.summary, ...current.filter((s) => s.id !== session.session_id)]);
      navigate({ to: "/session/$id", params: { id: session.session_id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    const config = loadConfig();
    if (!config) {
      setAuthError("Configure your backend URL in Settings first.");
      return;
    }

    setAuthError(null);
    try {
      const result = await signInWithGoogle(config, window.location.href);
      window.location.assign(result.url);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSetupClaim(e: React.FormEvent) {
    e.preventDefault();
    const config = loadConfig();
    if (!config) {
      setAuthError("Configure your backend URL in Settings first.");
      return;
    }

    setSetupSubmitting(true);
    setAuthError(null);
    try {
      const auth = await claimSetup(config, setupToken.trim());
      setAuthState(auth);
      setSetupToken("");
      if (auth.membership?.status === "active") {
        await refreshSessions();
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupSubmitting(false);
    }
  }

  async function handleSignOut() {
    const config = loadConfig();
    if (!config) return;

    setSigningOut(true);
    setAuthError(null);
    try {
      await signOut(config);
      const auth = await getAuthMe(config);
      setAuthState(auth);
      setSessions([]);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningOut(false);
    }
  }

  const canCreate =
    !loading &&
    !modelsLoading &&
    modelOptions.length > 0 &&
    Boolean(repo.trim() && provider.trim() && planModel.trim() && execModel.trim());

  const counts = useMemo(() => {
    const map = { running: 0, review: 0, done: 0 } as Record<string, number>;
    for (const session of sessions) {
      const status = deriveStatus(session);
      if (status in map) map[status] += 1;
    }
    return map;
  }, [sessions]);

  const visibleSessions = useMemo(
    () =>
      filter === "all"
        ? sessions
        : sessions.filter((session) => deriveStatus(session) === filter),
    [sessions, filter],
  );

  if (authLoading) {
    return (
      <main className="home-page">
        <div className="home-page-inner">
          <section className="home-hero">
            <div className="home-eyebrow">Codevil</div>
            <h1 className="home-hero-title">Loading</h1>
          </section>
        </div>
      </main>
    );
  }

  if (!loadConfig()) {
    return (
      <SetupGate
        title="Connect Codevil"
        copy="Configure your backend URL in Settings before continuing."
        error={authError}
      />
    );
  }

  if (!authState?.authConfigured) {
    return (
      <SetupGate
        title="Auth is not configured"
        copy="Set Better Auth and Google OAuth environment variables on the Worker, then reload."
        error={authError}
      />
    );
  }

  if (!authState.authenticated) {
    return (
      <SetupGate
        title={authState.setupRequired ? "Set up this Codevil instance" : "Sign in to Codevil"}
        copy="Continue with Google to authenticate with this self-hosted team."
        actionLabel="Continue with Google"
        onAction={handleGoogleSignIn}
        error={authError}
      />
    );
  }

  if (authState.setupRequired && !authState.membership) {
    return (
      <SetupGate
        title="Claim this Codevil instance"
        copy={`Signed in as ${authState.user?.email ?? "authenticated user"}. Enter the setup token configured on the Worker.`}
        error={authError}
      >
        <AuthStatus auth={authState} onSignOut={handleSignOut} signingOut={signingOut} />
        <form className="home-launcher" onSubmit={handleSetupClaim}>
          <label className="home-launcher-field">
            <span>Setup token</span>
            <input
              type="password"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              required
            />
          </label>
          <div className="home-launcher-foot">
            <span className="home-launcher-hint">{authState.user?.email}</span>
            <button type="submit" className="home-launcher-create" disabled={!setupToken.trim() || setupSubmitting}>
              {setupSubmitting ? "Claiming…" : "Create owner account"}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </SetupGate>
    );
  }

  if (!authState.membership) {
    return (
      <SetupGate
        title="Access required"
        copy="Ask an owner or admin for an invite to this Codevil instance."
        error={authError}
      >
        <AuthStatus auth={authState} onSignOut={handleSignOut} signingOut={signingOut} />
      </SetupGate>
    );
  }

  return (
    <main className="home-page">
      <div className="home-page-inner">
        <section className="home-hero">
          <div className="home-eyebrow">New session</div>
          <h1 className="home-hero-title">Start a room</h1>
          <p className="home-hero-sub">
            Point Codevil at a repo, pick your models, and bring your team into a shared room with the agent.
          </p>
        </section>

        <form className="home-launcher" onSubmit={handleSubmit}>
          <div className="home-launcher-repo">
            <span className="home-launcher-repo-glyph">
              <GithubGlyph />
            </span>
            <input
              id="repo"
              placeholder="github.com/user/repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCreate) {
                  e.preventDefault();
                  void handleSubmit(e as unknown as React.FormEvent);
                }
              }}
              required
            />
          </div>

          <div className="home-launcher-models">
            <label className="home-launcher-field">
              <span>Provider</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {SUPPORTED_PROVIDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.displayName}</option>
                ))}
              </select>
            </label>
            <label className="home-launcher-field">
              <span>Plan model</span>
              <select
                value={planModel}
                onChange={(e) => setPlanModel(e.target.value)}
                disabled={modelsLoading || modelOptions.length === 0}
                required
              >
                {modelsLoading ? (
                  <option value={planModel}>Loading models…</option>
                ) : (
                  modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))
                )}
              </select>
            </label>
            <label className="home-launcher-field">
              <span>Exec model</span>
              <select
                value={execModel}
                onChange={(e) => setExecModel(e.target.value)}
                disabled={modelsLoading || modelOptions.length === 0}
                required
              >
                {modelsLoading ? (
                  <option value={execModel}>Loading models…</option>
                ) : (
                  modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))
                )}
              </select>
            </label>
          </div>

          {modelsError && <p className="home-error">{modelsError}</p>}

          {error && <p className="home-error">{error}</p>}

          <div className="home-launcher-foot">
            <span className="home-launcher-hint">
              Press <kbd>⌘</kbd> <kbd>↵</kbd> to create
            </span>
            <button type="submit" className="home-launcher-create" disabled={!canCreate}>
              {loading ? "Creating…" : "Create room"}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>

        <section className="home-sessions" aria-labelledby="recent-sessions-title">
          <div className="home-sessions-head">
            <h2 id="recent-sessions-title">Recent sessions</h2>
            <div className="home-filter" role="tablist" aria-label="Filter sessions">
              {FILTERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value}
                  className={`home-filter-tab${filter === value ? " active" : ""}`}
                  onClick={() => setFilter(value)}
                >
                  {FILTER_LABEL[value]}
                  {value !== "all" && counts[value] > 0 && (
                    <span className="home-filter-count">{counts[value]}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {visibleSessions.length > 0 ? (
            <div className="home-session-cards">
              {visibleSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onOpen={() => navigate({ to: "/session/$id", params: { id: session.id } })}
                />
              ))}
            </div>
          ) : (
            <div className="home-sessions-empty">
              <div className="home-sessions-empty-mark" aria-hidden="true">
                <GithubGlyph />
              </div>
              <div>
                <div className="home-sessions-empty-title">
                  {sessions.length === 0 ? "No sessions yet" : `No ${FILTER_LABEL[filter].toLowerCase()} sessions`}
                </div>
                <div className="home-sessions-empty-copy">
                  Point Codevil at a repository above to start a shared room with the agent.
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

interface SetupGateProps {
  title: string;
  copy: string;
  actionLabel?: string;
  onAction?: () => void;
  error?: string | null;
  children?: React.ReactNode;
}

function SetupGate({ title, copy, actionLabel, onAction, error, children }: SetupGateProps) {
  return (
    <main className="home-page">
      <div className="home-page-inner">
        <section className="home-hero">
          <div className="home-eyebrow">Codevil auth</div>
          <h1 className="home-hero-title">{title}</h1>
          <p className="home-hero-sub">{copy}</p>
        </section>
        {children}
        {actionLabel && onAction && (
          <div className="home-launcher-foot">
            <span className="home-launcher-hint">Google OAuth</span>
            <button type="button" className="home-launcher-create" onClick={onAction}>
              {actionLabel}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        )}
        {error && <p className="home-error">{error}</p>}
      </div>
    </main>
  );
}

interface AuthStatusProps {
  auth: AuthMeResponse;
  signingOut: boolean;
  onSignOut: () => void;
}

function AuthStatus({ auth, signingOut, onSignOut }: AuthStatusProps) {
  if (!auth.user) return null;

  return (
    <div className="home-auth-status">
      <span>
        <strong>{auth.user.name || auth.user.email}</strong>
        <span>{auth.user.email}</span>
      </span>
      <button type="button" onClick={onSignOut} disabled={signingOut}>
        {signingOut ? "Signing out..." : "Sign out"}
      </button>
    </div>
  );
}

interface SessionCardProps {
  session: SessionSummary;
  onOpen: () => void;
}

function SessionCard({ session, onOpen }: SessionCardProps) {
  const status = deriveStatus(session);
  const owner = session.created_by ?? { id: session.id, name: session.title };
  const avatarColors = assignParticipantAvatarColors([owner]);
  const ownerColor = avatarColors.get(getParticipantColorKey(owner));

  return (
    <button type="button" className="home-session-card" onClick={onOpen}>
      <span className="home-session-card-glyph" aria-hidden="true">
        <GithubGlyph />
      </span>
      <span className="home-session-card-body">
        <span className="home-session-card-title">{session.title}</span>
        <span className="home-session-card-sub">
          <span className="home-session-card-repo">{session.repo}</span>
          <span className="home-session-card-branch">main</span>
        </span>
      </span>
      <span className="home-session-card-meta">
        <span className={`home-status-pill ${status}`}>
          <span className="home-status-dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </span>
        <span className="home-session-card-foot">
          <span
            className="home-session-card-avatar"
            title={owner.name}
            style={{ "--avatar-color": ownerColor } as CSSProperties}
          >
            {owner.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="home-session-card-time">{formatRelativeTime(session.last_event_at)}</span>
        </span>
      </span>
    </button>
  );
}
