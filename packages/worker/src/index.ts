import { Orchestrator } from "./orchestrator.js";

interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  CODEVIL_API_KEY: string;
}

export { Orchestrator };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!authenticate(request, env.CODEVIL_API_KEY)) {
      return json({ error: "Unauthorized" }, 401);
    }

    // POST /sessions — create a new session
    if (path === "/sessions" && request.method === "POST") {
      return handleCreateSession(request, env);
    }

    // GET /sessions/:id/ws — WebSocket upgrade
    const wsMatch = path.match(/^\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && request.method === "GET") {
      return handleWebSocketUpgrade(request, env, wsMatch[1]);
    }

    // POST /sessions/:id/simulate — trigger test events (dev only)
    const simMatch = path.match(/^\/sessions\/([^/]+)\/simulate$/);
    if (simMatch && request.method === "POST") {
      return handleSimulate(env, simMatch[1]);
    }

    return json({ error: "Not found" }, 404);
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
  let body: { prompt: string; repo: string };
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

  await stub.init(sessionId, body.prompt, body.repo);

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

async function handleSimulate(env: Env, sessionId: string): Promise<Response> {
  const doId = env.ORCHESTRATOR.idFromName(sessionId);
  const stub = env.ORCHESTRATOR.get(doId);
  await stub.simulateTestEvents();
  return json({ ok: true }, 200);
}

function json(data: unknown, status: number): Response {
  return Response.json(data, { status });
}
