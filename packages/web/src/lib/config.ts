import type { SessionConfig } from "../types";

const STORAGE_KEY = "codevil_config";

export function loadConfig(): SessionConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.endpoint === "string") {
      return { endpoint: parsed.endpoint };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: SessionConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}
