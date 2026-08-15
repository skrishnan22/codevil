import assert from "node:assert/strict";
import test from "node:test";

import * as sandboxConnection from "../dist/sandbox-connection.js";

const {
  SANDBOX_RECONNECT_GRACE_MS,
  sandboxConnectionMode,
  sandboxReconnectExpired,
} = sandboxConnection;

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
  assert.equal(sandboxConnectionMode("initializing", undefined, 0), "reject");
  assert.equal(sandboxConnectionMode("ready", undefined), "reject");
  assert.equal(sandboxConnectionMode("executing", undefined, 1), "reject");
  assert.equal(
    sandboxConnectionMode("failed", "2026-06-20T13:28:13.000Z"),
    "reject",
  );
});

test("resumes an orphaned sandbox during repository setup or an active session", () => {
  assert.equal(sandboxConnectionMode("cloning_repo", undefined, 0), "resume");
  assert.equal(sandboxConnectionMode("ready", undefined, 0), "resume");
});

test("reconnect side effects preserve cloning state until clone_complete", () => {
  const operations = [];
  const host = {
    meta: { state: "cloning_repo", sandbox_disconnected_at: "2026-06-20T13:28:13.000Z" },
    saveMeta() {
      operations.push("save");
    },
    appendAndBroadcast(event) {
      operations.push(event);
    },
    updateDirectory(patch) {
      operations.push(patch);
    },
  };

  assert.equal(typeof sandboxConnection.completeSandboxReconnect, "function");
  if (typeof sandboxConnection.completeSandboxReconnect !== "function") return;
  sandboxConnection.completeSandboxReconnect(host);

  assert.equal(host.meta.sandbox_disconnected_at, undefined);
  assert.deepEqual(operations, [
    "save",
    { type: "status", message: "Sandbox reconnected." },
    { sandbox_state: "cloning" },
  ]);
});

test("resumes an active session when the sandbox socket was lost without a close marker", () => {
  assert.equal(sandboxConnectionMode("planning", undefined, 0), "resume");
  assert.equal(sandboxConnectionMode("executing", undefined, 0), "resume");
  assert.equal(sandboxConnectionMode("awaiting_approval", undefined, 0), "resume");
  assert.equal(sandboxConnectionMode("verifying", undefined, 0), "resume");
});

test("expires reconnect grace after the configured deadline", () => {
  const disconnectedAt = "2026-06-20T13:28:13.000Z";
  const start = Date.parse(disconnectedAt);

  assert.equal(sandboxReconnectExpired(disconnectedAt, start + SANDBOX_RECONNECT_GRACE_MS - 1), false);
  assert.equal(sandboxReconnectExpired(disconnectedAt, start + SANDBOX_RECONNECT_GRACE_MS), true);
});
