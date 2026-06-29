export type TelemetryComponent = "cli" | "worker" | "orchestrator" | "sandbox";
export type TelemetrySeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface SpanEvent {
  name: string;
  time_unix_nano: number;
  attributes?: Record<string, unknown>;
}

export interface SpanStatus {
  code: "UNSET" | "OK" | "ERROR";
  message?: string;
}

export type WideEventOutcome = "success" | "error";
export type WideEventRecordType = "span" | "point";

/** Domain context groups merged at the top level of each wide event (loggingsucks.com style). */
export type WideEventGroups = {
  session?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  run?: Record<string, unknown>;
  request?: Record<string, unknown>;
  error?: Record<string, unknown>;
  [group: string]: Record<string, unknown> | undefined;
};

const KNOWN_WIDE_EVENT_GROUPS = new Set(["session", "sandbox", "run", "request", "error"]);

const RESERVED_WIDE_EVENT_KEYS = new Set([
  "kind",
  "record_type",
  "timestamp",
  "trace_id",
  "span_id",
  "parent_span_id",
  "session_id",
  "service",
  "operation",
  "severity",
  "duration_ms",
  "outcome",
  "status",
  "events",
]);

export function partitionWideEventAttributes(
  attributes: Record<string, unknown>,
): { groups: WideEventGroups; flat: Record<string, unknown> } {
  const groups: WideEventGroups = {};
  const flat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (KNOWN_WIDE_EVENT_GROUPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      groups[key] = value as Record<string, unknown>;
    } else {
      flat[key] = value;
    }
  }

  return { groups, flat };
}

/**
 * Canonical telemetry record — one wide event per span hop or point-in-time signal.
 * See docs/logging.md and https://loggingsucks.com/
 */
export interface EmittedWideEvent {
  kind: "wide_event";
  record_type: WideEventRecordType;
  timestamp: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  session_id?: string;
  service: TelemetryComponent;
  operation: string;
  severity?: TelemetrySeverity;
  duration_ms?: number;
  outcome: WideEventOutcome;
  status?: SpanStatus;
  events?: SpanEvent[];
  session?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  run?: Record<string, unknown>;
  request?: Record<string, unknown>;
  error?: Record<string, unknown>;
  [key: string]: unknown;
}

export class WideEventBuilder {
  private readonly groups: WideEventGroups = {};
  private flat: Record<string, unknown> = {};

  set(key: string, value: unknown): this {
    if (!RESERVED_WIDE_EVENT_KEYS.has(key)) {
      this.flat[key] = value;
    }
    return this;
  }

  setGroup(name: string, values: Record<string, unknown>): this {
    this.groups[name] = values;
    return this;
  }

  merge(attributes: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(attributes)) {
      this.set(key, value);
    }
    return this;
  }

  groupsSnapshot(): WideEventGroups {
    return { ...this.groups };
  }

  flatSnapshot(): Record<string, unknown> {
    return { ...this.flat };
  }
}

export function wideEventOutcomeFromStatus(status: SpanStatus): WideEventOutcome {
  return status.code === "ERROR" ? "error" : "success";
}

export function assembleWideEvent(input: {
  record_type: WideEventRecordType;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  session_id?: string;
  service: TelemetryComponent;
  operation: string;
  severity?: TelemetrySeverity;
  duration_ms?: number;
  outcome: WideEventOutcome;
  status?: SpanStatus;
  events?: SpanEvent[];
  groups?: WideEventGroups;
  flat?: Record<string, unknown>;
}): EmittedWideEvent {
  const groups = input.groups ?? {};
  const flat = input.flat ?? {};

  const event: EmittedWideEvent = {
    kind: "wide_event",
    record_type: input.record_type,
    timestamp: new Date().toISOString(),
    service: input.service,
    operation: input.operation,
    outcome: input.outcome,
    ...(input.trace_id ? { trace_id: input.trace_id } : {}),
    ...(input.span_id ? { span_id: input.span_id } : {}),
    ...(input.parent_span_id ? { parent_span_id: input.parent_span_id } : {}),
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.events && input.events.length > 0 ? { events: input.events } : {}),
  };

  for (const [name, values] of Object.entries(groups)) {
    if (values && Object.keys(values).length > 0) {
      event[name] = values;
    }
  }

  for (const [key, value] of Object.entries(flat)) {
    if (value !== undefined && !RESERVED_WIDE_EVENT_KEYS.has(key)) {
      event[key] = value;
    }
  }

  return event;
}

export function severityToOutcome(severity: TelemetrySeverity): WideEventOutcome {
  return severity === "ERROR" ? "error" : "success";
}
