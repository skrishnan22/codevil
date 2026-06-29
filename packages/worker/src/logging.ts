import {
  createComponentLogger,
  logException,
  type ComponentLogger,
} from "@codevil/shared";

const workerLogger = createComponentLogger("worker");

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
