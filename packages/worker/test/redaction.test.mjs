import assert from "node:assert/strict";
import test from "node:test";

import { redactEvent } from "../dist/redaction.js";

test("redacts exact secret values from nested event payloads", () => {
  const event = redactEvent({
    type: "agent_event",
    event: {
      command: "echo sk-live-secret",
      output: {
        text: "token sk-live-secret was printed",
      },
    },
  }, ["sk-live-secret"]);

  assert.deepEqual(event, {
    type: "agent_event",
    event: {
      command: "echo [REDACTED]",
      output: {
        text: "token [REDACTED] was printed",
      },
    },
  });
});

test("redacts common token patterns without mutating original event", () => {
  const original = {
    type: "status",
    message: "ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890 and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  };

  const redacted = redactEvent(original, []);

  assert.equal(original.message.includes("sk-ant-api03"), true);
  assert.deepEqual(redacted, {
    type: "status",
    message: "ANTHROPIC_API_KEY=[REDACTED] and [REDACTED]",
  });
});

test("redacts explicitly configured short and whitespace-padded secrets", () => {
  const configuredSecret = " key ";

  const redacted = redactEvent({
    nested: {
      stdout: "sandbox printed key",
      stderr: "failed with key",
    },
  }, [configuredSecret]);

  assert.deepEqual(redacted, {
    nested: {
      stdout: "sandbox printed [REDACTED]",
      stderr: "failed with [REDACTED]",
    },
  });
});

test("redacts cyclic diagnostic objects without throwing or retaining secrets", () => {
  const diagnostic = { message: "sandbox returned cycle-secret" };
  diagnostic.self = diagnostic;
  const error = new Error("cycle-secret in error");
  error.diagnostic = diagnostic;

  const redacted = redactEvent({ diagnostic, error }, ["cycle-secret"]);

  assert.equal(redacted.diagnostic.message, "sandbox returned [REDACTED]");
  assert.equal(redacted.diagnostic.self, redacted.diagnostic);
  assert.equal(redacted.error.message, "[REDACTED] in error");
  assert.equal(redacted.error.diagnostic.self, redacted.error.diagnostic);
});

test("redacts Error causes and custom properties without invoking throwing diagnostic getters", () => {
  const secret = "error-boundary-secret";
  const cause = new Error(`upstream rejected ${secret}`);
  cause.context = { detail: `provider returned ${secret}` };
  const error = new Error(`request failed with ${secret}`, { cause });
  error.provider_context = { stdout: `sandbox printed ${secret}` };
  Object.defineProperty(error, "diagnostic", {
    enumerable: true,
    get() {
      throw new Error("diagnostic getter must not run");
    },
  });

  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactEvent({ error }, [secret]);
  });

  assert.equal(redacted.error.message, "request failed with [REDACTED]");
  assert.equal(redacted.error.cause.message, "upstream rejected [REDACTED]");
  assert.equal(redacted.error.cause.context.detail, "provider returned [REDACTED]");
  assert.equal(redacted.error.provider_context.stdout, "sandbox printed [REDACTED]");
  assert.equal(redacted.error.diagnostic, "[UNAVAILABLE]");
});
