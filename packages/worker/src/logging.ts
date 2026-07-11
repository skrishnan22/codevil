import {
  createComponentLogger,
  logException,
  type ComponentLogger,
  type Severity,
} from "@codevil/shared";
import { isHealthCheckPath } from "./health.js";

const workerLogger = createComponentLogger("worker");

const SESSION_PATH_RE = /^\/sessions\/([^/]+)/;

export function extractSessionIdFromPath(path: string): string | undefined {
  const match = path.match(SESSION_PATH_RE);
  return match?.[1];
}

export function withRequestId(response: Response, requestId: string): Response {
  const patched = new Response(response.body, response);
  patched.headers.set("x-request-id", requestId);
  return patched;
}

export function isWebSocketUpgradeResponse(response: Response): boolean {
  return response.status === 101 || Boolean((response as { webSocket?: unknown }).webSocket);
}

// Finalize a response produced by dispatchHttpRequest: attach the request id
// and emit the canonical request log. WebSocket upgrades are returned as the
// exact same instance — reconstructing a 101 drops the webSocket property and
// breaks the handshake in workerd.
export function observeRoutedResponse(
  routed: Response,
  ctx: { requestId: string; method: string; path: string; startedAt: number },
): Response {
  if (isWebSocketUpgradeResponse(routed)) return routed;

  const response = withRequestId(routed, ctx.requestId);
  logHttpApiRequest({
    requestId: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    status: response.status,
    durationMs: Date.now() - ctx.startedAt,
    sessionId: extractSessionIdFromPath(ctx.path),
  });
  return response;
}

export function logHttpApiRequest(opts: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  sessionId?: string;
}): void {
  const { requestId, method, path, status, durationMs, sessionId } = opts;

  if (isHealthCheckPath(path) && status < 400) return;

  const severity: Severity = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "DEBUG";
  const attributes: Record<string, unknown> = {
    request_id: requestId,
    duration_ms: durationMs,
    request: { method, path, status },
  };
  if (sessionId) attributes.session_id = sessionId;

  workerLog(severity, "request.http", attributes);
}

export function handleUncaughtHttpError(
  error: unknown,
  ctx: {
    requestId: string;
    method: string;
    path: string;
    startedAt: number;
    withCors: (response: Response) => Response;
  },
): Response {
  workerLogException("request.http.failed", error, {
    request_id: ctx.requestId,
    duration_ms: Date.now() - ctx.startedAt,
    request: { method: ctx.method, path: ctx.path },
  });
  return ctx.withCors(withRequestId(
    Response.json({ error: "Internal error" }, { status: 500 }),
    ctx.requestId,
  ));
}

export function workerLog(
  severity: Parameters<ComponentLogger["log"]>[0],
  event: string,
  attributes: Record<string, unknown> = {},
): void {
  workerLogger.log(severity, event, attributes);
}

export function workerLogForSession(
  sessionId: string,
  severity: Parameters<ComponentLogger["log"]>[0],
  event: string,
  attributes: Record<string, unknown> = {},
): void {
  const logger = createComponentLogger("worker");
  logger.withSessionId(sessionId);
  logger.log(severity, event, attributes);
}

export function workerLogException(
  event: string,
  error: unknown,
  attributes: Record<string, unknown> = {},
): void {
  logException(workerLogger, event, error, attributes);
}

export function workerLogSessionException(
  sessionId: string,
  event: string,
  error: unknown,
  attributes: Record<string, unknown> = {},
): void {
  const logger = createComponentLogger("worker");
  logger.withSessionId(sessionId);
  logException(logger, event, error, attributes);
}

export function sandboxLifecycleLogger(sessionId?: string): ComponentLogger {
  const logger = createComponentLogger("worker");
  if (sessionId) logger.withSessionId(sessionId);
  return logger;
}
