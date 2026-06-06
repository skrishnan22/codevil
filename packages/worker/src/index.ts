import { Orchestrator } from "./orchestrator.js";
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import {
  buildSessionSummary,
  normalizeCreateSessionBody,
  recentSessionsSelect,
  sessionByIdSelect,
  sessionDirectoryFailureUpdate,
  sessionDirectoryInsert,
  type SessionDirectoryRow,
} from "./session-directory.js";

// Subclass the Cloudflare Sandbox so we can shorten the idle timeout. The base
// class auto-suspends the container after `sleepAfter` of no traffic.
export class Sandbox<Env = unknown> extends BaseSandbox<Env> {
  override sleepAfter = "10m";

  override async fetch(request: Request): Promise<Response> {
    // The base Sandbox.fetch() routes by URL path/port and ignores the
    // cf-container-target-port header that switchPort() sets. We need the
    // header path so callers can use sandbox.fetch(switchPort(req, port)) —
    // the only way to proxy WebSocket upgrades across the DO boundary, since
    // containerFetch() is JSRPC and cannot transport a WebSocket pair.
    const header = request.headers.get("cf-container-target-port");
    if (header) {
      const port = Number.parseInt(header, 10);
      if (Number.isFinite(port)) {
        return this.containerFetch(request, port);
      }
    }
    return super.fetch(request);
  }
}

interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  CODEVIL_API_KEY: string;
}

export { Orchestrator };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Upgrade",
};

function withCors(response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(k, v);
  }
  return patched;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const hostPreview = previewTokenFromHost(url.hostname);
    if (hostPreview) {
      return handleSessionPreview(request, env, hostPreview.sessionId, hostPreview.token);
    }

    const previewMatch = path.match(/^\/sessions\/([^/]+)\/preview\/([^/]+)(?:\/.*)?$/);
    if (previewMatch) {
      return handleSessionPreview(request, env, previewMatch[1], previewMatch[2]);
    }

    if (!authenticate(request, env.CODEVIL_API_KEY)) {
      return withCors(json({ error: "Unauthorized" }, 401));
    }

    // POST /sessions — create a new session
    if (path === "/sessions" && request.method === "POST") {
      return withCors(await handleCreateSession(request, env));
    }

    if (path === "/sessions" && request.method === "GET") {
      return withCors(await handleListSessions(request, env));
    }

    const sessionInfoMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionInfoMatch && request.method === "GET") {
      return withCors(await handleGetSession(request, env, sessionInfoMatch[1]));
    }

    // GET /sessions/:id/ws — WebSocket upgrade
    const wsMatch = path.match(/^\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && request.method === "GET") {
      return handleWebSocketUpgrade(request, env, wsMatch[1]);
    }

    const sandboxWsMatch = path.match(/^\/sessions\/([^/]+)\/sandbox\/ws$/);
    if (sandboxWsMatch && request.method === "GET") {
      return handleSandboxWebSocketUpgrade(request, env, sandboxWsMatch[1]);
    }

    // GET /sessions/:id/logs — read sandbox process logs (dev only)
    const logsMatch = path.match(/^\/sessions\/([^/]+)\/logs$/);
    if (logsMatch && request.method === "GET") {
      return withCors(await handleLogs(env, logsMatch[1]));
    }

    // POST /sessions/:id/simulate — trigger test events (dev only)
    const simMatch = path.match(/^\/sessions\/([^/]+)\/simulate$/);
    if (simMatch && request.method === "POST") {
      return withCors(await handleSimulate(env, simMatch[1]));
    }

    return withCors(json({ error: "Not found" }, 404));
  },
} satisfies ExportedHandler<Env>;

function authenticate(request: Request, apiKey: string): boolean {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const [scheme, token] = auth.split(" ", 2);
    if (scheme === "Bearer" && token === apiKey) return true;
  }

  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam === apiKey) return true;

  return false;
}

function previewTokenFromHost(hostname: string): { sessionId: string; token: string } | null {
  const label = hostname.split(".", 1)[0];
  const match = label.match(/^(ses-[a-f0-9]{32})-[a-f0-9]{24}$/);
  if (!match) return null;
  return {
    sessionId: match[1].replace(/^ses-/, "ses_"),
    token: label,
  };
}

async function handleCreateSession(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  let normalized: ReturnType<typeof normalizeCreateSessionBody>;
  try {
    normalized = normalizeCreateSessionBody(body);
  } catch (error) {
    return json({
      error: "Invalid session body",
      detail: error instanceof Error ? error.message : String(error),
    }, 400);
  }

  const sessionId = `ses_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();
  const row: SessionDirectoryRow = {
    id: sessionId,
    repo: normalized.repo,
    title: normalized.title,
    provider: normalized.provider,
    plan_model: normalized.plan_model,
    exec_model: normalized.exec_model,
    max_cost: normalized.max_cost,
    max_session_time: normalized.max_session_time,
    max_idle_time: normalized.max_idle_time,
    max_steps: normalized.max_steps,
    room_state: "initializing",
    sandbox_state: "not_started",
    created_by_id: normalized.created_by?.id,
    created_by_name: normalized.created_by?.name,
    created_at: now,
    updated_at: now,
    last_event_at: now,
  };
  const insert = sessionDirectoryInsert(row);
  await env.DB.prepare(insert.sql).bind(...insert.bindings).run();

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);

  try {
    await stub.init(sessionId, normalized.title, normalized.repo, {
      worker_url: new URL("/", request.url).toString().replace(/\/$/, ""),
      provider: normalized.provider,
      plan_model: normalized.plan_model,
      exec_model: normalized.exec_model,
      max_cost: normalized.max_cost,
      max_time: normalized.max_session_time,
      max_steps: normalized.max_steps,
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failure = sessionDirectoryFailureUpdate(sessionId, failedAt);
    await env.DB.prepare(failure.sql).bind(...failure.bindings).run();
    console.error("session.init.failed", {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({
      error: "Failed to initialize session",
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }

  return json({
    session_id: sessionId,
    ws_url: new URL(`/sessions/${sessionId}/ws`, request.url).toString(),
    summary: buildSessionSummary(row),
  }, 201);
}

async function handleListSessions(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const select = recentSessionsSelect(cutoff, limit);
  const result = await env.DB
    .prepare(select.sql)
    .bind(...select.bindings)
    .all<SessionDirectoryRow>();

  return json({
    sessions: (result.results ?? []).map(buildSessionSummary),
  }, 200);
}

async function handleGetSession(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const select = sessionByIdSelect(sessionId);
  const row = await env.DB
    .prepare(select.sql)
    .bind(...select.bindings)
    .first<SessionDirectoryRow>();

  if (!row) {
    return json({ error: "Session not found" }, 404);
  }

  return json({
    session: buildSessionSummary(row),
    ws_url: new URL(`/sessions/${sessionId}/ws`, request.url).toString(),
  }, 200);
}

async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return json({ error: "Expected Upgrade: websocket" }, 426);
  }

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  return stub.fetch(request);
}

async function handleSandboxWebSocketUpgrade(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return json({ error: "Expected Upgrade: websocket" }, 426);
  }

  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  return stub.fetch(request);
}

async function handleSessionPreview(
  request: Request,
  env: Env,
  sessionId: string,
  token: string,
): Promise<Response> {
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  return stub.fetchPreview(request, token);
}

async function handleLogs(env: Env, sessionId: string): Promise<Response> {
  try {
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(env.Sandbox, sessionId);
    const logs = await sandbox.getProcessLogs("codevil-agent");
    return json(logs, 200);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

async function handleSimulate(env: Env, sessionId: string): Promise<Response> {
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  await stub.simulateTestEvents();
  return json({ ok: true }, 200);
}

function json(data: unknown, status: number): Response {
  return Response.json(data, { status });
}
