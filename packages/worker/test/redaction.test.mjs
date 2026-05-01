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
