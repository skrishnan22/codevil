// Tracer / Span / wide-event telemetry for Codevil.
//
// Philosophy: https://loggingsucks.com/ — one wide, context-rich event per hop.
// A Codevil session IS a trace. session_id → trace_id. Phase spans are canonical
// wide events; Pi tool calls are span events (not separate spans) to limit noise.
//
// Query with: wrangler tail | jq 'select(.kind=="wide_event" and .session_id=="ses_...")'

import {
  WideEventBuilder,
  assembleWideEvent,
  partitionWideEventAttributes,
  severityToOutcome,
  wideEventOutcomeFromStatus,
  type EmittedWideEvent,
  type WideEventGroups,
} from "./wide-event.js";

export type {
  WideEventOutcome,
  WideEventRecordType,
  WideEventGroups,
  EmittedWideEvent,
} from "./wide-event.js";
export { WideEventBuilder, assembleWideEvent, partitionWideEventAttributes, severityToOutcome, wideEventOutcomeFromStatus } from "./wide-event.js";

export type Component = "cli" | "worker" | "orchestrator" | "sandbox";
export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type SpanKind = "internal" | "client" | "server" | "producer" | "consumer";
export type SpanStatusCode = "UNSET" | "OK" | "ERROR";

export interface SpanContext {
  trace_id: string;
  span_id: string;
}

export interface SpanEvent {
  name: string;
  time_unix_nano: number;
  attributes?: Record<string, unknown>;
}

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface SpanOptions {
  parent?: SpanContext;
  kind?: SpanKind;
  attributes?: Record<string, unknown>;
}

export interface Span {
  context(): SpanContext;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  setAttribute(key: string, value: unknown): void;
  setGroup(name: string, values: Record<string, unknown>): void;
  mergeContext(attributes: Record<string, unknown>): void;
  setStatus(code: SpanStatusCode, message?: string): void;
  end(): void;
}

/** @deprecated Use EmittedWideEvent with record_type "span". */
export type EmittedSpan = EmittedWideEvent;

/** @deprecated Use EmittedWideEvent with record_type "point". */
export type EmittedLog = EmittedWideEvent;

export type TracerSink = (line: EmittedWideEvent) => void;

export interface CreateTracerOptions {
  component: Component;
  trace_id: string;
  session_id?: string;
  sink?: TracerSink;
}

export interface Tracer {
  trace_id: string;
  component: Component;
  startSpan(name: string, options?: SpanOptions): Span;
  span<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T>;
  log(
    severity: Severity,
    event: string,
    attributes?: Record<string, unknown>,
    span_context?: SpanContext,
  ): void;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += buf[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}

export const defaultTracerSink: TracerSink = (line) => {
  try {
    console.log(JSON.stringify(line));
  } catch {
    console.log("[observability_emit_failed]", line.operation, line.service);
  }
};

let sharedSink: TracerSink = defaultTracerSink;

export function setTracerSink(sink: TracerSink): void {
  sharedSink = sink;
}

function nowNanos(): number {
  return Date.now() * 1_000_000;
}

class LiveSpan implements Span {
  private readonly _ctx: SpanContext;
  private readonly _name: string;
  private readonly _component: Component;
  private readonly _kind: SpanKind;
  private readonly _parent?: SpanContext;
  private readonly _session_id?: string;
  private readonly _start: number;
  private readonly _builder = new WideEventBuilder();
  private _events: SpanEvent[] = [];
  private _status: SpanStatus = { code: "UNSET" };
  private _ended = false;
  private readonly _sink: TracerSink;

  constructor(args: {
    ctx: SpanContext;
    name: string;
    component: Component;
    kind: SpanKind;
    parent?: SpanContext;
    session_id?: string;
    attributes?: Record<string, unknown>;
    sink: TracerSink;
  }) {
    this._ctx = args.ctx;
    this._name = args.name;
    this._component = args.component;
    this._kind = args.kind;
    this._parent = args.parent;
    this._session_id = args.session_id;
    this._sink = args.sink;
    this._start = nowNanos();
    if (args.attributes) this._builder.merge(args.attributes);
    this._builder.set("span_kind", args.kind);
  }

  context(): SpanContext {
    return this._ctx;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    if (this._ended) return;
    this._events.push({
      name,
      time_unix_nano: nowNanos(),
      ...(attributes ? { attributes } : {}),
    });
  }

  setAttribute(key: string, value: unknown): void {
    if (this._ended) return;
    this._builder.set(key, value);
  }

  setGroup(name: string, values: Record<string, unknown>): void {
    if (this._ended) return;
    this._builder.setGroup(name, values);
  }

  mergeContext(attributes: Record<string, unknown>): void {
    if (this._ended) return;
    this._builder.merge(attributes);
  }

  setStatus(code: SpanStatusCode, message?: string): void {
    if (this._ended) return;
    this._status = message ? { code, message } : { code };
    if (code === "ERROR" && message) {
      this._builder.setGroup("error", {
        type: "SpanError",
        message,
      });
    }
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    const end = nowNanos();
    const duration_ms = Math.round((end - this._start) / 1_000_000);
    const status = this._status.code === "UNSET" ? { code: "OK" as const } : this._status;

    this._sink(assembleWideEvent({
      record_type: "span",
      trace_id: this._ctx.trace_id,
      span_id: this._ctx.span_id,
      parent_span_id: this._parent?.span_id,
      session_id: this._session_id,
      service: this._component,
      operation: this._name,
      duration_ms,
      outcome: wideEventOutcomeFromStatus(status),
      status,
      events: this._events,
      groups: this._builder.groupsSnapshot(),
      flat: this._builder.flatSnapshot(),
    }));
  }
}

class LiveTracer implements Tracer {
  readonly trace_id: string;
  readonly component: Component;
  private readonly session_id?: string;
  private readonly sink: TracerSink;

  constructor(opts: CreateTracerOptions) {
    this.trace_id = opts.trace_id;
    this.component = opts.component;
    this.session_id = opts.session_id;
    this.sink = opts.sink ?? ((line) => sharedSink(line));
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    return new LiveSpan({
      ctx: { trace_id: this.trace_id, span_id: newSpanId() },
      name,
      component: this.component,
      kind: options.kind ?? "internal",
      parent: options.parent,
      session_id: this.session_id,
      attributes: options.attributes,
      sink: this.sink,
    });
  }

  async span<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T> | T,
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      span.setStatus("OK");
      return result;
    } catch (error) {
      span.setStatus(
        "ERROR",
        error instanceof Error ? error.message : String(error),
      );
      span.addEvent("exception", {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (error instanceof Error) {
        const errorGroup: Record<string, unknown> = {
          type: error.name,
          message: error.message,
          stack: error.stack,
        };
        for (const [key, value] of Object.entries(error)) {
          if (key !== "name" && key !== "message" && key !== "stack") {
            errorGroup[key] = value;
          }
        }
        span.setGroup("error", errorGroup);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  log(
    severity: Severity,
    operation: string,
    attributes: Record<string, unknown> = {},
    span_context?: SpanContext,
  ): void {
    const session_id = typeof attributes.session_id === "string"
      ? attributes.session_id
      : this.session_id;

    const { groups, flat } = partitionWideEventAttributes(attributes);
    if (typeof flat.error === "string") {
      groups.error = {
        type: "Error",
        message: flat.error,
        ...(typeof flat.stack === "string" ? { stack: flat.stack } : {}),
      };
      delete flat.error;
      delete flat.stack;
    }

    this.sink(assembleWideEvent({
      record_type: "point",
      trace_id: this.trace_id,
      span_id: span_context?.span_id,
      session_id,
      service: this.component,
      operation,
      severity,
      outcome: severityToOutcome(severity),
      groups,
      flat,
    }));
  }
}

export function emitLog(opts: {
  severity: Severity;
  event: string;
  component: Component;
  trace_id?: string;
  span_id?: string;
  attributes?: Record<string, unknown>;
}): void {
  const { groups, flat } = partitionWideEventAttributes(opts.attributes ?? {});
  const session_id = typeof flat.session_id === "string" ? flat.session_id : undefined;
  if (session_id) delete flat.session_id;

  sharedSink(assembleWideEvent({
    record_type: "point",
    trace_id: opts.trace_id,
    span_id: opts.span_id,
    session_id,
    service: opts.component,
    operation: opts.event,
    severity: opts.severity,
    outcome: severityToOutcome(opts.severity),
    groups,
    flat,
  }));
}

export function traceIdFromSessionId(sessionId: string): string {
  const hex = sessionId.replace(/^ses_/, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? hex.toLowerCase() : hex.padEnd(32, "0").slice(0, 32);
}

export interface ComponentLogger {
  log(severity: Severity, event: string, attributes?: Record<string, unknown>): void;
  withTraceId(traceId: string): void;
  withSessionId(sessionId: string): void;
}

export function createComponentLogger(
  component: Component,
  traceId?: string,
): ComponentLogger {
  let currentTraceId = traceId ?? newTraceId();
  let sessionId: string | undefined;

  const log = (
    severity: Severity,
    event: string,
    attributes: Record<string, unknown> = {},
  ): void => {
    emitLog({
      severity,
      event,
      component,
      trace_id: currentTraceId,
      attributes: sessionId ? { session_id: sessionId, ...attributes } : attributes,
    });
  };

  return {
    log,
    withTraceId(next: string) {
      currentTraceId = next;
    },
    withSessionId(next: string) {
      sessionId = next;
      currentTraceId = traceIdFromSessionId(next);
    },
  };
}

export function logException(
  logger: ComponentLogger,
  operation: string,
  error: unknown,
  attributes: Record<string, unknown> = {},
): void {
  logger.log("ERROR", operation, {
    ...attributes,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
}

export function createTracer(opts: CreateTracerOptions): Tracer {
  return new LiveTracer(opts);
}
