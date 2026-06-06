import type { SessionConfig } from "../types";

const STORAGE_KEY = "codevil_config";

export function loadConfig(): SessionConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.endpoint === "string" && typeof parsed.apiKey === "string") {
      const participantId = typeof parsed.participantId === "string"
        ? parsed.participantId
        : generateParticipantId();
      const config = {
        endpoint: parsed.endpoint,
        apiKey: parsed.apiKey,
        participantId,
        ...(typeof parsed.displayName === "string" ? { displayName: parsed.displayName } : {}),
      };
      if (parsed.participantId !== participantId) saveConfig(config);
      return config;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: SessionConfig): void {
  const participantId = config.participantId ?? loadExistingParticipantId() ?? generateParticipantId();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...config, participantId }));
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function loadExistingParticipantId(): string | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof parsed.participantId === "string" ? parsed.participantId : null;
  } catch {
    return null;
  }
}

function generateParticipantId(): string {
  return `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
