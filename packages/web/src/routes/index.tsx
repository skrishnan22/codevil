import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { loadConfig } from "@/lib/config";
import { createSession, listSessions } from "@/lib/api-client";
import { DEFAULT_CONFIG } from "@codevil/shared";
import type { SessionSummary } from "@/types";

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

function HomePage() {
  const navigate = useNavigate();
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState(DEFAULT_CONFIG.provider);
  const [planModel, setPlanModel] = useState(DEFAULT_CONFIG.plan_model);
  const [execModel, setExecModel] = useState(DEFAULT_CONFIG.exec_model);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

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

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">New Room</h1>
      <form onSubmit={handleSubmit} className="mt-6 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="repo">Repository</Label>
          <Input
            id="repo"
            placeholder="github.com/user/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="provider">Provider</Label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="opencode-go">OpenCode Go</option>
              <option value="kimi-coding">Kimi For Coding</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="planModel">Plan model</Label>
            <input
              id="planModel"
              list="model-options"
              value={planModel}
              onChange={(e) => setPlanModel(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="execModel">Exec model</Label>
            <input
              id="execModel"
              list="model-options"
              value={execModel}
              onChange={(e) => setExecModel(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              required
            />
          </div>
          <datalist id="model-options">
            {MODEL_OPTIONS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="submit"
          disabled={
            loading ||
            !repo.trim() ||
            !provider.trim() ||
            !planModel.trim() ||
            !execModel.trim()
          }
        >
          {loading ? "Creating..." : "Create Room"}
        </Button>
      </form>

      {sessions.length > 0 && (
        <div className="mt-12">
          <h2 className="text-lg font-semibold">Recent Sessions</h2>
          <div className="mt-4 grid gap-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                className="flex items-center justify-between rounded-md border p-3 text-left hover:bg-muted"
                onClick={() => navigate({ to: "/session/$id", params: { id: s.id } })}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.title}</p>
                  <p className="truncate text-sm text-muted-foreground">{s.repo}</p>
                </div>
                <Badge variant="outline" className="ml-4 shrink-0">{s.sandbox_state}</Badge>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
