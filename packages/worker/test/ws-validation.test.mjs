import assert from "node:assert/strict";
import test from "node:test";

import { clientValidationErrorMessage } from "../../shared/dist/index.js";
import { dispatchSandboxSocketMessage } from "../dist/orchestrator/sandbox-handlers.js";

test("clientValidationErrorMessage includes type when present", () => {
  assert.equal(
    clientValidationErrorMessage({ type: "not_a_real_message" }),
    "Invalid message (type: not_a_real_message)",
  );
  assert.equal(clientValidationErrorMessage({ foo: 1 }), "Invalid message");
  assert.equal(clientValidationErrorMessage("raw string"), "Invalid message");
});

test("dispatchSandboxSocketMessage replies with protocol_error on schema validation failure", async () => {
  const sent = [];
  const ws = {
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const host = {
    meta: { session_id: "ses_test" },
    loadMeta() {},
  };

  await dispatchSandboxSocketMessage(host, ws, JSON.stringify({ type: "not_a_sandbox_message" }));

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "protocol_error",
    message: "Invalid message (type: not_a_sandbox_message)",
  });
});

test("dispatchSandboxSocketMessage replies with protocol_error on invalid JSON", async () => {
  const sent = [];
  const ws = {
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  await dispatchSandboxSocketMessage({ loadMeta() {} }, ws, "not json");

  assert.deepEqual(sent[0], { type: "protocol_error", message: "Invalid JSON" });
});
