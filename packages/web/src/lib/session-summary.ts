import type { SessionSummary } from "@/types";

const SESSIONS_KEY = "codevil_sessions";
const MODEL_PREFS_KEY = "codevil_model_prefs";

export interface StoredModelPrefs {
  provider?: string;
  planModel?: string;
  execModel?: string;
}

export function loadStoredSession(sessionId: string | null): SessionSummary | null {
  if (!sessionId || typeof localStorage === "undefined") return null;

  try {
    const sessions = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]") as SessionSummary[];
    return sessions.find((session) => session.id === sessionId) ?? null;
  } catch {
    return null;
  }
}

export function loadStoredModelPrefs(): StoredModelPrefs {
  if (typeof localStorage === "undefined") return {};

  try {
    const prefs = JSON.parse(localStorage.getItem(MODEL_PREFS_KEY) ?? "{}") as StoredModelPrefs;
    return {
      provider: typeof prefs.provider === "string" ? prefs.provider : undefined,
      planModel: typeof prefs.planModel === "string" ? prefs.planModel : undefined,
      execModel: typeof prefs.execModel === "string" ? prefs.execModel : undefined,
    };
  } catch {
    return {};
  }
}
