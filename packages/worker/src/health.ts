import { missingAuthConfigKeys } from "./auth-config.js";
import { json } from "./http-handlers.js";
import type { Env } from "./worker-env.js";

export function isHealthCheckPath(path: string): boolean {
  return path === "/health" || path === "/ready";
}

export function handleHealth(): Response {
  return json({ ok: true }, 200);
}

export async function checkD1Reachable(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

export function checkAuthConfigPresent(env: Env): boolean {
  return missingAuthConfigKeys(env).length === 0;
}

export function checkApiKeyPresent(env: Env): boolean {
  return typeof env.CODEVIL_API_KEY === "string" && env.CODEVIL_API_KEY.trim().length > 0;
}

export async function handleReady(env: Env): Promise<Response> {
  const d1 = await checkD1Reachable(env.DB);
  const auth_config = checkAuthConfigPresent(env);
  const api_key = checkApiKeyPresent(env);
  const checks = { d1, auth_config, api_key };
  const ok = d1 && auth_config && api_key;
  return json({ ok, checks }, ok ? 200 : 503);
}
