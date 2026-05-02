import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { loadConfig } from "@/lib/config";
import { createSession } from "@/lib/api-client";
import { DEFAULT_CONFIG } from "@codevil/shared";
import type { SessionSummary } from "@/types";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const SESSIONS_KEY = "codevil_sessions";
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

function loadSessions(): SessionSummary[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionSummary[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
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
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState(DEFAULT_CONFIG.provider);
  const [planModel, setPlanModel] = useState(DEFAULT_CONFIG.plan_model);
  const [execModel, setExecModel] = useState(DEFAULT_CONFIG.exec_model);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    setSessions(loadSessions());
    const prefs = loadModelPrefs();
    setProvider(prefs.provider);
    setPlanModel(prefs.planModel);
    setExecModel(prefs.execModel);
  }, []);

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
      const session = await createSession(config, { prompt, repo, ...modelPrefs });
      const summary: SessionSummary = {
        id: session.session_id,
        prompt,
        repo,
        state: "initializing",
        createdAt: Date.now(),
      };
      const updated = [summary, ...loadSessions()];
      saveSessions(updated);
      navigate({ to: "/session/$id", params: { id: session.session_id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">New Session</h1>
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
        <div className="grid gap-2">
          <Label htmlFor="prompt">Task</Label>
          <Input
            id="prompt"
            placeholder="Describe what you want to build or change..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
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
            !prompt.trim() ||
            !repo.trim() ||
            !provider.trim() ||
            !planModel.trim() ||
            !execModel.trim()
          }
        >
          {loading ? "Creating..." : "Start Session"}
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
                  <p className="truncate font-medium">{s.prompt}</p>
                  <p className="truncate text-sm text-muted-foreground">{s.repo}</p>
                </div>
                <Badge variant="outline" className="ml-4 shrink-0">{s.state}</Badge>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
