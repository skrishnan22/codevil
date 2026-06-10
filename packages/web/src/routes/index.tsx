import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { loadConfig } from "@/lib/config";
import { createSession, listSessions } from "@/lib/api-client";
import { DEFAULT_CONFIG } from "@codevil/shared";
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

const MODEL_OPTIONS = [
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-for-coding",
  "kimi-k2-thinking",
  "glm-5.1",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
];

interface ModelPrefs {
  provider: string;
  planModel: string;
  execModel: string;
}

function loadModelPrefs(): ModelPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_PREFS_KEY) ?? "{}");
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : DEFAULT_CONFIG.provider,
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

  useEffect(() => {
    const prefs = loadModelPrefs();
    setProvider(prefs.provider);
    setPlanModel(prefs.planModel);
    setExecModel(prefs.execModel);
    void refreshSessions();
  }, []);

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

  const canCreate =
    !loading &&
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
                <option value="opencode-go">OpenCode Go</option>
                <option value="kimi-coding">Kimi For Coding</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label className="home-launcher-field">
              <span>Plan model</span>
              <input
                list="model-options"
                value={planModel}
                onChange={(e) => setPlanModel(e.target.value)}
                required
              />
            </label>
            <label className="home-launcher-field">
              <span>Exec model</span>
              <input
                list="model-options"
                value={execModel}
                onChange={(e) => setExecModel(e.target.value)}
                required
              />
            </label>
            <datalist id="model-options">
              {MODEL_OPTIONS.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </div>

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
