import { Orchestrator } from "./orchestrator.js";
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import {
  recordSandboxLifecycleEvent,
  SANDBOX_KEEPALIVE_STATE_KEY,
  SANDBOX_LIFECYCLE_EVENT_KEY,
  shouldDeferSandboxActivityExpiry,
  type SandboxKeepAliveState,
  type SandboxLifecycleEvent,
} from "./sandbox.js";
import { configuredWebOrigins } from "./auth-config.js";
import { dispatchHttpRequest } from "./http-router.js";
import { json } from "./http-handlers.js";
import {
  handleUncaughtHttpError,
  observeRoutedResponse,
  sandboxLifecycleLogger,
  withRequestId,
} from "./logging.js";
import type { Env } from "./worker-env.js";

export type { Env } from "./worker-env.js";

// Subclass the Cloudflare Sandbox so Codevil can keep active agent sessions
// alive and persist stop diagnostics across abnormal socket closures.
export class Sandbox<Env = unknown> extends BaseSandbox<Env> {
  override sleepAfter = "10m";

  async setCodevilKeepAlive(active: boolean, reason = "unspecified"): Promise<void> {
    const state: SandboxKeepAliveState = {
      active,
      reason,
      updated_at: new Date().toISOString(),
    };
    await this.ctx.storage.put(SANDBOX_KEEPALIVE_STATE_KEY, state);
    if (active) this.renewActivityTimeout();
    sandboxLifecycleLogger(this.sessionId()).log("INFO", "sandbox.keepalive", {
      sandbox: { ...state },
    });
  }

  async getCodevilLifecycleSnapshot(): Promise<{
    keepAlive?: SandboxKeepAliveState;
    lastEvent?: SandboxLifecycleEvent;
  }> {
    const [keepAlive, lastEvent] = await Promise.all([
      this.ctx.storage.get<SandboxKeepAliveState>(SANDBOX_KEEPALIVE_STATE_KEY),
      this.ctx.storage.get<SandboxLifecycleEvent>(SANDBOX_LIFECYCLE_EVENT_KEY),
    ]);
    return {
      ...(keepAlive ? { keepAlive } : {}),
      ...(lastEvent ? { lastEvent } : {}),
    };
  }

  override async onStart(): Promise<void> {
    await this.recordLifecycle({ type: "start", at: new Date().toISOString() });
    await Promise.resolve(super.onStart());
  }

  override async onStop(params?: unknown): Promise<void> {
    await this.recordLifecycle({
      type: "stop",
      at: new Date().toISOString(),
      ...stopDiagnostics(params),
    });
    await Promise.resolve(super.onStop());
  }

  override async onError(error: unknown): Promise<void> {
    await this.recordLifecycle({
      type: "error",
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    await Promise.resolve(super.onError(error));
  }

  override async onActivityExpired(): Promise<void> {
    const keepAlive = await this.ctx.storage.get<SandboxKeepAliveState>(SANDBOX_KEEPALIVE_STATE_KEY);
    if (keepAlive && shouldDeferSandboxActivityExpiry(keepAlive)) {
      await this.recordLifecycle({
        type: "activity_expired_deferred",
        at: new Date().toISOString(),
        reason: keepAlive.reason,
      });
      this.renewActivityTimeout();
      sandboxLifecycleLogger(this.sessionId()).log("INFO", "sandbox.activity_expired_deferred", {
        sandbox: { ...keepAlive },
      });
      return;
    }

    await this.recordLifecycle({
      type: "activity_expired",
      at: new Date().toISOString(),
    });
    await super.onActivityExpired();
  }

  private async recordLifecycle(event: SandboxLifecycleEvent): Promise<void> {
    sandboxLifecycleLogger(this.sessionId()).log("INFO", "sandbox.lifecycle", {
      sandbox: { ...event },
    });
    await recordSandboxLifecycleEvent(this.ctx.storage, event);
  }

  private sessionId(): string | undefined {
    const name = this.ctx.id.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }

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

function stopDiagnostics(params: unknown): Pick<SandboxLifecycleEvent, "exit_code" | "reason"> {
  if (!params || typeof params !== "object") return {};

  const record = params as Record<string, unknown>;
  const exitCode = record.exitCode;
  const reason = record.reason;

  return {
    ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

export { Orchestrator };

const CORS_BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Upgrade",
  "Vary": "Origin",
};

function corsHeadersFor(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin")?.replace(/\/$/, "");
  if (!origin) {
    return {
      ...CORS_BASE_HEADERS,
      "Access-Control-Allow-Origin": "*",
    };
  }

  if (configuredWebOrigins(env).includes(origin)) {
    return {
      ...CORS_BASE_HEADERS,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    };
  }

  return {
    ...CORS_BASE_HEADERS,
    "Access-Control-Allow-Origin": "*",
  };
}

function withCors(request: Request, env: Env, response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeadersFor(request, env))) {
    patched.headers.set(k, v);
  }
  return patched;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(request, env) });
    }

    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const path = new URL(request.url).pathname;
    const applyCors = (response: Response) => withCors(request, env, response);

    try {
      const routed = await dispatchHttpRequest(request, env, { withCors });
      if (routed) {
        return observeRoutedResponse(routed, {
          requestId,
          method: request.method,
          path,
          startedAt,
        });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return env.ASSETS.fetch(request);
      }

      return applyCors(withRequestId(json({ error: "Not found" }, 404), requestId));
    } catch (error) {
      return handleUncaughtHttpError(error, {
        requestId,
        method: request.method,
        path,
        startedAt,
        withCors: applyCors,
      });
    }
  },
} satisfies ExportedHandler<Env>;
