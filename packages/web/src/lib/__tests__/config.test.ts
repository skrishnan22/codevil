import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfig, loadConfig, saveConfig } from "../config";

function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("uses a deploy-time backend URL when local storage has no override", () => {
    vi.stubEnv("VITE_CODEVIL_API_URL", "https://codevil.example.workers.dev/");

    expect(loadConfig()).toEqual({ endpoint: "https://codevil.example.workers.dev" });
  });

  it("prefers the saved backend URL over the deploy-time default", () => {
    vi.stubEnv("VITE_CODEVIL_API_URL", "https://default.example.workers.dev");
    saveConfig({ endpoint: "https://saved.example.workers.dev/" });

    expect(loadConfig()).toEqual({ endpoint: "https://saved.example.workers.dev" });
  });

  it("uses the current origin when the UI and API are deployed together", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "codevil.example.workers.dev",
        origin: "https://codevil.example.workers.dev",
      },
    });

    expect(loadConfig()).toEqual({ endpoint: "https://codevil.example.workers.dev" });
  });

  it("uses the local Worker URL for localhost development without a saved override", () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
    });

    expect(loadConfig()).toEqual({ endpoint: "http://localhost:8787" });
  });

  it("falls back to the deploy-time backend URL after clearing the override", () => {
    vi.stubEnv("VITE_CODEVIL_API_URL", "https://codevil.example.workers.dev");
    saveConfig({ endpoint: "https://saved.example.workers.dev" });

    clearConfig();

    expect(loadConfig()).toEqual({ endpoint: "https://codevil.example.workers.dev" });
  });
});
