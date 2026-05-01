import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, type Config } from "@codevil/shared";

export interface ConfigPathOptions {
  home?: string;
  configPath?: string;
}

export function getConfigPath(options: ConfigPathOptions = {}): string {
  return options.configPath ?? join(options.home ?? homedir(), ".codevil", "config");
}

export interface CreateConfigOptions {
  provider?: string;
}

export function createConfig(endpoint: string, apiKey: string, options: CreateConfigOptions = {}): Config {
  return {
    endpoint: normalizeEndpoint(endpoint),
    api_key: apiKey,
    defaults: {
      ...DEFAULT_CONFIG,
      provider: options.provider ?? DEFAULT_CONFIG.provider,
    },
  };
}

export async function readConfig(options: ConfigPathOptions = {}): Promise<Config> {
  const path = getConfigPath(options);

  try {
    const raw = await readFile(path, "utf8");
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("No Codevil config found. Run `codevil init` first.");
    }
    throw error;
  }
}

export async function writeConfig(
  config: Config,
  options: ConfigPathOptions = {},
): Promise<void> {
  const path = getConfigPath(options);
  const normalized = validateConfig({
    ...config,
    endpoint: normalizeEndpoint(config.endpoint),
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("Endpoint URL is required");

  const url = new URL(trimmed);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateConfig(value: unknown): Config {
  if (!isRecord(value)) throw new Error("Invalid Codevil config");
  if (typeof value.endpoint !== "string") throw new Error("Invalid Codevil config: endpoint is required");
  if (typeof value.api_key !== "string") throw new Error("Invalid Codevil config: api_key is required");

  return {
    endpoint: normalizeEndpoint(value.endpoint),
    api_key: value.api_key,
    defaults: {
      ...DEFAULT_CONFIG,
      ...(isRecord(value.defaults) ? value.defaults : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
