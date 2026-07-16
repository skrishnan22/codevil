import {
  createComponentLogger,
  logException,
  type ComponentLogger,
} from "@codevil/shared";

let bootstrapLogger = createComponentLogger("sandbox");

export function sandboxLogger(): ComponentLogger {
  return bootstrapLogger;
}

export function setSandboxTraceFromSession(sessionId: string): void {
  bootstrapLogger.withSessionId(sessionId);
}

export function sandboxLogException(
  event: string,
  error: unknown,
  attributes: Record<string, unknown> = {},
): void {
  logException(bootstrapLogger, event, error, attributes);
}

export function wsUrlForLog(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "[invalid ws url]";
  }
}

export function sessionIdFromWsUrl(wsUrl: string): string | undefined {
  const match = wsUrl.match(/\/sessions\/([^/]+)\/sandbox\/ws/);
  return match?.[1];
}
