import type { ZodIssue, ZodTypeAny, infer as ZodInfer } from "zod";

import type { Tracer } from "./observability.js";

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

let sink: DropSink = (drop) => {
  // Single structured log line. Cloudflare Workers, Node sandbox, and the CLI
  // all surface stderr to their respective log pipelines.
  try {
    console.error(JSON.stringify(drop));
  } catch {
    console.error("[validation_drop]", drop.boundary, drop.raw_type);
  }
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

function readRawType(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "type" in raw) {
    const t = (raw as { type: unknown }).type;
    return typeof t === "string" ? t : null;
  }
  return null;
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
