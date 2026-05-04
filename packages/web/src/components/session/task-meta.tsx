import { loadStoredModelPrefs } from "@/lib/session-summary";

export function TaskMeta() {
  const prefs = loadStoredModelPrefs();
  const provider = prefs.provider ?? "unknown";
  const planModel = prefs.planModel ?? "unknown";
  const execModel = prefs.execModel ?? "unknown";

  return (
    <div className="task-meta">
      <div>
        <span className="kv-label">Provider</span>
        <span className="kv-val">{provider}</span>
      </div>
      <div>
        <span className="kv-label">Plan</span>
        <span className="kv-val">{planModel}</span>
      </div>
      <div>
        <span className="kv-label">Exec</span>
        <span className="kv-val">{execModel}</span>
      </div>
    </div>
  );
}
