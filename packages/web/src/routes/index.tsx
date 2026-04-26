import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { loadConfig } from "@/lib/config";
import { createSession } from "@/lib/api-client";
import type { SessionSummary } from "@/types";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const SESSIONS_KEY = "codevil_sessions";

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

function HomePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    setSessions(loadSessions());
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
      const session = await createSession(config, { prompt, repo });
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
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={loading || !prompt.trim() || !repo.trim()}>
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
