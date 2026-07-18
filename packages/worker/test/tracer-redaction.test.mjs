import assert from "node:assert/strict";
import test from "node:test";

import { createTracer } from "@codevil/shared";
import { redactEvent } from "../dist/redaction.js";

test("trace sink redacts exception messages and nested sandbox output at the final boundary", async () => {
  const secret = "short-trace-secret";
  const lines = [];
  const tracer = createTracer({
    component: "orchestrator",
    trace_id: "0123456789abcdef0123456789abcdef",
    sink: (line) => lines.push(line),
    transform: (line) => redactEvent(line, [secret]),
  });

  await assert.rejects(
    tracer.span("sandbox.provision", {}, async () => {
      const error = new Error(`provisioning failed: ${secret}`);
      error.sandbox = { stdout: secret, nested: { stderr: `also ${secret}` } };
      throw error;
    }),
  );

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /provisioning failed/);
});
