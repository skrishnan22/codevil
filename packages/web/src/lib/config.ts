import type { SessionConfig } from "../types";

const STORAGE_KEY = "codevil_config";

export function loadConfig(): SessionConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const endpoint = normalizeEndpoint(parsed.endpoint);
      if (endpoint) {
        return { endpoint };
      }
    } catch {
      return defaultConfig();
    }
  }

  return defaultConfig();
}

export function saveConfig(config: SessionConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    endpoint: normalizeEndpoint(config.endpoint) ?? config.endpoint.trim(),
  }));
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function defaultConfig(): SessionConfig | null {
  const endpoint = normalizeEndpoint(import.meta.env.VITE_CODEVIL_API_URL);
  if (endpoint) return { endpoint };

  const localEndpoint = localDevelopmentEndpoint();
  return localEndpoint ? { endpoint: localEndpoint } : null;
}

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const endpoint = value.trim().replace(/\/+$/, "");
  return endpoint.length > 0 ? endpoint : null;
}

function localDevelopmentEndpoint(): string | null {
  if (typeof window === "undefined") return null;

  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "http://localhost:8787";
  }

  return null;
}
