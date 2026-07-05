import type { ZodIssue, ZodTypeAny, infer as ZodInfer } from "zod";

import type { Component, Tracer } from "./observability.js";
import { createComponentLogger, emitLog } from "./observability.js";

export type Boundary =
  | "cli_to_do"
  | "do_to_cli"
  | "do_to_sandbox"
  | "sandbox_to_do"
  | "pi_agent_event"
  | "persisted_replay";

export interface ValidationDrop {
  kind: "validation_drop";
  boundary: Boundary;
  raw_type: string | null;
  issues: ZodIssue[];
}

type DropSink = (drop: ValidationDrop) => void;

function componentForBoundary(boundary: Boundary): Component {
  switch (boundary) {
    case "cli_to_do":
      return "cli";
    case "do_to_cli":
    case "do_to_sandbox":
    case "persisted_replay":
      return "orchestrator";
    case "sandbox_to_do":
    case "pi_agent_event":
      return "sandbox";
  }
}

let sink: DropSink = (drop) => {
  emitLog({
    severity: "WARN",
    event: "validation_drop",
    component: componentForBoundary(drop.boundary),
    attributes: {
      boundary: drop.boundary,
      raw_type: drop.raw_type,
      issues: drop.issues,
    },
  });
};

export function setValidationDropSink(next: DropSink): void {
  sink = next;
}

// Sink factory that emits validation drops as a WARN log through a tracer,
// so each drop carries trace_id/span_id/component automatically.
export function tracerValidationDropSink(tracer: Tracer): DropSink {
  return (drop) => {
    tracer.log("WARN", "validation_drop", {
      boundary: drop.boundary,
      raw_type: drop.raw_type,
      issues: drop.issues,
    });
  };
}

/** Emit validation-style drops outside parseInbound (e.g. SQLite row hydration). */
export function emitValidationDrop(
  component: Component,
  boundary: string,
  issues: ZodIssue[],
  options: { raw_type?: string | null; session_id?: string } = {},
): void {
  const logger = createComponentLogger(component);
  if (options.session_id) logger.withSessionId(options.session_id);
  logger.log("WARN", "validation_drop", {
    boundary,
    raw_type: options.raw_type ?? null,
    issues,
  });
}

function readRawType(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "type" in raw) {
    const t = (raw as { type: unknown }).type;
    return typeof t === "string" ? t : null;
  }
  return null;
}

/** Client-facing error text for inbound messages that fail schema validation. */
export function clientValidationErrorMessage(raw: unknown): string {
  const rawType = readRawType(raw);
  return rawType ? `Invalid message (type: ${rawType})` : "Invalid message";
}

export function parseInbound<S extends ZodTypeAny>(
  schema: S,
  raw: unknown,
  boundary: Boundary,
): ZodInfer<S> | null {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  sink({
    kind: "validation_drop",
    boundary,
    raw_type: readRawType(raw),
    issues: result.error.issues,
  });
  return null;
}
