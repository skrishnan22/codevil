import assert from "node:assert/strict";
import test from "node:test";

import {
  createTracer,
  createComponentLogger,
  newTraceId,
  newSpanId,
  setTracerSink,
  setValidationDropSink,
  tracerValidationDropSink,
  traceIdFromSessionId,
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

test("startSpan + end emits one wide event span on the sink", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "orchestrator", trace_id: newTraceId() });
    const span = t.startSpan("phase.plan", { attributes: { state: "planning" } });
    span.setGroup("session", { repo: "github.com/acme/app" });
    span.setAttribute("model", "claude-sonnet-4-6");
    span.addEvent("step", { i: 1 });
    span.end();
  });
  assert.equal(lines.length, 1);
  const [event] = lines;
  assert.equal(event.kind, "wide_event");
  assert.equal(event.record_type, "span");
  assert.equal(event.operation, "phase.plan");
  assert.equal(event.service, "orchestrator");
  assert.equal(event.state, "planning");
  assert.equal(event.model, "claude-sonnet-4-6");
  assert.equal(event.session?.repo, "github.com/acme/app");
  assert.equal(event.events.length, 1);
  assert.equal(event.events[0].name, "step");
  assert.equal(event.status.code, "OK");
  assert.equal(event.outcome, "success");
  assert.ok(event.duration_ms >= 0);
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

test("tracer.log emits a wide event point record", () => {
  const lines = withSink(() => {
    const traceId = newTraceId();
    const t = createTracer({ component: "orchestrator", trace_id: traceId, session_id: "ses_abc" });
    t.log("INFO", "state.transition", { from: "planning", to: "awaiting_approval" });
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "wide_event");
  assert.equal(lines[0].record_type, "point");
  assert.equal(lines[0].severity, "INFO");
  assert.equal(lines[0].operation, "state.transition");
  assert.equal(lines[0].service, "orchestrator");
  assert.equal(lines[0].from, "planning");
  assert.equal(lines[0].session_id, "ses_abc");
});

test("createComponentLogger attaches session_id to every log", () => {
  const lines = withSink(() => {
    const logger = createComponentLogger("worker");
    logger.withSessionId("ses_deadbeef");
    logger.log("INFO", "session.init.failed", { detail: "boom" });
  });
  assert.equal(lines[0].session_id, "ses_deadbeef");
});

test("traceIdFromSessionId strips ses_ prefix", () => {
  assert.equal(
    traceIdFromSessionId("ses_0123456789abcdef0123456789abcdef"),
    "0123456789abcdef0123456789abcdef",
  );
});

test("tracer.log includes span_id when span context passed", () => {
  const lines = withSink(() => {
    const t = createTracer({ component: "sandbox", trace_id: newTraceId() });
    const span = t.startSpan("op");
    t.log("WARN", "noisy", { detail: "x" }, span.context());
    span.end();
  });
  const log = lines.find((line) => line.record_type === "point");
  const span = lines.find((line) => line.record_type === "span");
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
  assert.equal(lines[0].kind, "wide_event");
  assert.equal(lines[0].operation, "validation_drop");
  assert.equal(lines[0].severity, "WARN");
  assert.equal(lines[0].boundary, "cli_to_do");
  assert.equal(lines[0].raw_type, "unknown");
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
  assert.equal(lines[0].events?.length ?? 0, 0);
  assert.equal(lines[0].late, undefined);
});
