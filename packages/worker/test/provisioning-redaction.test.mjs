import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const workerShim = encodeURIComponent(`
  export class DurableObject {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  }
`);
const loader = encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,${workerShim}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`);
register(`data:text/javascript,${loader}`, import.meta.url);

test("provisioning telemetry redacts provider credentials from errors without hiding diagnostics", async () => {
  const [{ traceSandboxProvisioning }, { createTracer }] = await Promise.all([
    import("../dist/orchestrator.js"),
    import("@codevil/shared"),
  ]);
  const emitted = [];
  const tracer = createTracer({
    component: "orchestrator",
    trace_id: "0123456789abcdef0123456789abcdef",
    sink: (event) => emitted.push(event),
  });
  const providerKey = "provider-credential-reflected-12345";
  const failure = new Error(`container rejected ${providerKey}`);
  failure.stack = `Error: container rejected ${providerKey}\n    at provision (sandbox.js:1:1)`;
  failure.details = {
    authorization: `Bearer ${providerKey}`,
    diagnostic: "container unavailable",
  };

  await assert.rejects(
    () => traceSandboxProvisioning({
      tracer,
      secrets: [providerKey],
      attributes: { provider: "openai" },
      provision: async () => {
        throw failure;
      },
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(providerKey));
      assert.match(error.message, /container rejected \[REDACTED\]/);
      return true;
    },
  );

  const serialized = JSON.stringify(emitted);
  assert.doesNotMatch(serialized, new RegExp(providerKey));
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /container unavailable/);
  assert.equal(
    emitted.some(
      (event) =>
        event.kind === "wide_event" &&
        event.record_type === "span" &&
        event.operation === "sandbox.provision" &&
        event.outcome === "error",
    ),
    true,
  );
});

test("provisioning telemetry survives hostile exception accessors", async () => {
  const [{ traceSandboxProvisioning }, { createTracer }] = await Promise.all([
    import("../dist/orchestrator.js"),
    import("@codevil/shared"),
  ]);
  const emitted = [];
  const tracer = createTracer({
    component: "orchestrator",
    trace_id: "0123456789abcdef0123456789abcdef",
    sink: (event) => emitted.push(event),
  });
  const error = {};
  for (const key of ["name", "message", "stack", "details"]) {
    Object.defineProperty(error, key, {
      enumerable: true,
      get() {
        throw new Error(`hostile ${key} getter`);
      },
    });
  }

  await assert.rejects(
    () => traceSandboxProvisioning({
      tracer,
      secrets: [],
      attributes: { provider: "openai" },
      provision: async () => {
        throw error;
      },
    }),
    (caught) => {
      assert.equal(caught.message, "[UNAVAILABLE]");
      return true;
    },
  );

  const serialized = JSON.stringify(emitted);
  assert.doesNotMatch(serialized, /hostile .* getter/);
  assert.match(serialized, /\[UNAVAILABLE\]/);
});
