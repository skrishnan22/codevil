// Tracer / Span / structured log emit for Codevil.
//
// A Codevil session IS a trace. session_id → trace_id. Phases are top-level
// spans; subprocess and LLM-call spans nest beneath them. Pi tool calls are
// recorded as `events` on the active phase span — never their own spans —
// to avoid cardinality explosion on chatty plan loops.
//
// One stdout JSON line per emit, OTLP-shaped, no SDK. Field names match
// OpenTelemetry semantic conventions so the eventual switch to an OTLP HTTP
// exporter or vendor SDK is one change to `createSink`, not re-instrumenting
// every call site.

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
  setStatus(code: SpanStatusCode, message?: string): void;
  end(): void;
}

export interface EmittedSpan {
  kind: "span";
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  component: Component;
  span_kind: SpanKind;
  start_unix_nano: number;
  end_unix_nano: number;
  duration_ms: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface EmittedLog {
  kind: "log";
  severity: Severity;
  event: string;
  component: Component;
  timestamp_unix_nano: number;
  trace_id?: string;
  span_id?: string;
  attributes: Record<string, unknown>;
}

export type TracerSink = (line: EmittedSpan | EmittedLog) => void;

export interface CreateTracerOptions {
  component: Component;
  trace_id: string;
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

// --- ID generation --------------------------------------------------

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += buf[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

// OTLP: 16-byte (32 hex) trace ID, 8-byte (16 hex) span ID.
export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}

// --- Sink ----------------------------------------------------------

export const defaultTracerSink: TracerSink = (line) => {
  try {
    console.log(JSON.stringify(line));
  } catch {
    console.log("[observability_emit_failed]", line.kind, "component" in line ? line.component : "");
  }
};

let sharedSink: TracerSink = defaultTracerSink;

export function setTracerSink(sink: TracerSink): void {
  sharedSink = sink;
}

function nowNanos(): number {
  return Date.now() * 1_000_000;
}

// --- Tracer + Span -------------------------------------------------

class LiveSpan implements Span {
  private readonly _ctx: SpanContext;
  private readonly _name: string;
  private readonly _component: Component;
  private readonly _kind: SpanKind;
  private readonly _parent?: SpanContext;
  private readonly _start: number;
  private _attributes: Record<string, unknown>;
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
    attributes?: Record<string, unknown>;
    sink: TracerSink;
  }) {
    this._ctx = args.ctx;
    this._name = args.name;
    this._component = args.component;
    this._kind = args.kind;
    this._parent = args.parent;
    this._attributes = { ...(args.attributes ?? {}) };
    this._sink = args.sink;
    this._start = nowNanos();
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
    this._attributes[key] = value;
  }

  setStatus(code: SpanStatusCode, message?: string): void {
    if (this._ended) return;
    this._status = message ? { code, message } : { code };
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    const end = nowNanos();
    const emitted: EmittedSpan = {
      kind: "span",
      trace_id: this._ctx.trace_id,
      span_id: this._ctx.span_id,
      ...(this._parent ? { parent_span_id: this._parent.span_id } : {}),
      name: this._name,
      component: this._component,
      span_kind: this._kind,
      start_unix_nano: this._start,
      end_unix_nano: end,
      duration_ms: Math.round((end - this._start) / 1_000_000),
      status: this._status.code === "UNSET" ? { code: "OK" } : this._status,
      attributes: this._attributes,
      events: this._events,
    };
    this._sink(emitted);
  }
}

class LiveTracer implements Tracer {
  readonly trace_id: string;
  readonly component: Component;
  private readonly sink: TracerSink;

  constructor(opts: CreateTracerOptions) {
    this.trace_id = opts.trace_id;
    this.component = opts.component;
    this.sink = opts.sink ?? ((line) => sharedSink(line));
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    return new LiveSpan({
      ctx: { trace_id: this.trace_id, span_id: newSpanId() },
      name,
      component: this.component,
      kind: options.kind ?? "internal",
      parent: options.parent,
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
      throw error;
    } finally {
      span.end();
    }
  }

  log(
    severity: Severity,
    event: string,
    attributes: Record<string, unknown> = {},
    span_context?: SpanContext,
  ): void {
    const emitted: EmittedLog = {
      kind: "log",
      severity,
      event,
      component: this.component,
      timestamp_unix_nano: nowNanos(),
      trace_id: this.trace_id,
      ...(span_context ? { span_id: span_context.span_id } : {}),
      attributes,
    };
    this.sink(emitted);
  }
}

export function createTracer(opts: CreateTracerOptions): Tracer {
  return new LiveTracer(opts);
}
