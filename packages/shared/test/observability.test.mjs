import assert from "node:assert/strict";
import test from "node:test";

import {
  createTracer,
  newTraceId,
  newSpanId,
  setTracerSink,
  setValidationDropSink,
  tracerValidationDropSink,
  parseInbound,
  CLIToDOMessageSchema,
} from "../dist/index.js";

function withSink(run) {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    run(lines);
  } finally {
    setTracerSink(() => {});
  }
  return lines;
}

async function withSinkAsync(run) {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    await run(lines);
  } finally {
    setTracerSink(() => {});
  }
  return lines;
}

test("newTraceId returns 32 lowercase hex chars", () => {
  const id = newTraceId();
  assert.match(id, /^[0-9a-f]{32}$/);
});

test("newSpanId returns 16 lowercase hex chars", () => {
  const id = newSpanId();
  assert.match(id, /^[0-9a-f]{16}$/);
});

test("startSpan + end emits one OTLP-shaped span on the sink", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "orchestrator", trace_id: newTraceId() });
    const span = t.startSpan("phase.plan", { attributes: { state: "planning" } });
    span.setAttribute("model", "claude-sonnet-4-6");
    span.addEvent("step", { i: 1 });
    span.end();
  });
  assert.equal(lines.length, 1);
  const [span] = lines;
  assert.equal(span.kind, "span");
  assert.equal(span.name, "phase.plan");
  assert.equal(span.component, "orchestrator");
  assert.equal(span.attributes.state, "planning");
  assert.equal(span.attributes.model, "claude-sonnet-4-6");
  assert.equal(span.events.length, 1);
  assert.equal(span.events[0].name, "step");
  assert.equal(span.status.code, "OK");
  assert.ok(span.duration_ms >= 0);
});

test("span() wraps fn, sets OK on success and ERROR on throw", async () => {
  const okLines = await withSinkAsync(async () => {
    const t = createTracer({ component: "sandbox", trace_id: newTraceId() });
    const value = await t.span("sandbox.clone", {}, async () => 42);
    assert.equal(value, 42);
  });
  assert.equal(okLines[0].status.code, "OK");

  const errLines = await withSinkAsync(async () => {
    const t = createTracer({ component: "sandbox", trace_id: newTraceId() });
    await assert.rejects(
      t.span("sandbox.clone", {}, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
  });
  assert.equal(errLines[0].status.code, "ERROR");
  assert.equal(errLines[0].status.message, "boom");
  assert.equal(errLines[0].events[0].name, "exception");
});

test("parent_span_id propagates from options.parent", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "orchestrator", trace_id: newTraceId() });
    const parent = t.startSpan("phase.plan");
    const child = t.startSpan("llm.plan", { parent: parent.context() });
    child.end();
    parent.end();
  });
  // child emits first (we ended it first), then parent
  assert.equal(lines[0].parent_span_id, lines[1].span_id);
  assert.equal(lines[0].trace_id, lines[1].trace_id);
});

test("tracer.log emits a log line with trace_id and component", () => {
  const lines = withSink(() => {
    const traceId = newTraceId();
    const t = createTracer({ component: "orchestrator", trace_id: traceId });
    t.log("INFO", "state.transition", { from: "planning", to: "awaiting_approval" });
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "log");
  assert.equal(lines[0].severity, "INFO");
  assert.equal(lines[0].event, "state.transition");
  assert.equal(lines[0].component, "orchestrator");
  assert.equal(lines[0].attributes.from, "planning");
});

test("tracer.log includes span_id when span context passed", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "sandbox", trace_id: newTraceId() });
    const span = t.startSpan("op");
    t.log("WARN", "noisy", { detail: "x" }, span.context());
    span.end();
  });
  const log = lines.find((line) => line.kind === "log");
  const span = lines.find((line) => line.kind === "span");
  assert.equal(log.span_id, span.span_id);
});

test("validation_drop emits through tracer when wired", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "orchestrator", trace_id: newTraceId() });
    setValidationDropSink(tracerValidationDropSink(t));
    const result = parseInbound(CLIToDOMessageSchema, { type: "unknown" }, "cli_to_do");
    assert.equal(result, null);
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "log");
  assert.equal(lines[0].event, "validation_drop");
  assert.equal(lines[0].severity, "WARN");
  assert.equal(lines[0].attributes.boundary, "cli_to_do");
  assert.equal(lines[0].attributes.raw_type, "unknown");
});

test("ended span ignores further mutations", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "cli", trace_id: newTraceId() });
    const span = t.startSpan("op");
    span.end();
    span.setAttribute("late", "ignored");
    span.addEvent("late_event");
    span.end(); // second end is a no-op
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].events.length, 0);
  assert.equal(lines[0].attributes.late, undefined);
});
