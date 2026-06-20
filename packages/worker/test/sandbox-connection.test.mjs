import assert from "node:assert/strict";
import test from "node:test";

import {
  SANDBOX_RECONNECT_GRACE_MS,
  sandboxConnectionMode,
  sandboxReconnectExpired,
} from "../dist/sandbox-connection.js";

test("initializes only the first provisioning connection", () => {
  assert.equal(sandboxConnectionMode("provisioning_sandbox", undefined), "initialize");
});

test("accepts a reconnect for a non-terminal session with a disconnect marker", () => {
  assert.equal(
    sandboxConnectionMode("ready", "2026-06-20T13:28:13.000Z"),
    "resume",
  );
  assert.equal(
    sandboxConnectionMode("executing", "2026-06-20T13:28:13.000Z"),
    "resume",
  );
});

test("rejects unsolicited and terminal reconnects", () => {
  assert.equal(sandboxConnectionMode("ready", undefined), "reject");
  assert.equal(
    sandboxConnectionMode("failed", "2026-06-20T13:28:13.000Z"),
    "reject",
  );
});

test("expires reconnect grace after the configured deadline", () => {
  const disconnectedAt = "2026-06-20T13:28:13.000Z";
  const start = Date.parse(disconnectedAt);

  assert.equal(sandboxReconnectExpired(disconnectedAt, start + SANDBOX_RECONNECT_GRACE_MS - 1), false);
  assert.equal(sandboxReconnectExpired(disconnectedAt, start + SANDBOX_RECONNECT_GRACE_MS), true);
});
