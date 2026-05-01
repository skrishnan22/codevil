import { Orchestrator } from "./orchestrator.js";
import type { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  CODEVIL_API_KEY: string;
}

export { Orchestrator };
export { Sandbox } from "@cloudflare/sandbox";

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

    if (!authenticate(request, env.CODEVIL_API_KEY)) {
      return withCors(json({ error: "Unauthorized" }, 401));
    }

    // POST /sessions — create a new session
    if (path === "/sessions" && request.method === "POST") {
      return withCors(await handleCreateSession(request, env));
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

async function handleCreateSession(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: {
    prompt: string;
    repo: string;
    provider?: string;
    plan_model?: string;
    exec_model?: string;
    max_cost?: string;
    max_time?: string;
    max_steps?: number;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.prompt || !body.repo) {
    return json({ error: "Missing required fields: prompt, repo" }, 400);
  }

  const sessionId = `ses_${crypto.randomUUID().replace(/-/g, "")}`;
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);

  try {
    await stub.init(sessionId, body.prompt, body.repo, {
      worker_url: new URL("/", request.url).toString().replace(/\/$/, ""),
      provider: body.provider,
      plan_model: body.plan_model,
      exec_model: body.exec_model,
      max_cost: body.max_cost,
      max_time: body.max_time,
      max_steps: body.max_steps,
    });
  } catch (error) {
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
  }, 201);
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
