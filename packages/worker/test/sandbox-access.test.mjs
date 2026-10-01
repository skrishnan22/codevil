import assert from "node:assert/strict";
import test from "node:test";

import {
  connectSandboxHandle,
  destroySandbox,
  readRedactedAgentLogs,
  sandboxDiagnosticsResponse,
  sandboxLogsResponse,
  sandboxRefForMeta,
} from "../dist/orchestrator/sandbox-access.js";
import { createFakeSandboxHandle } from "./helpers/fake-host.mjs";

const secret = "diagnostics-response-secret";

function recordingProvider(name) {
  const connects = [];
  return {
    connects,
    provider: {
      name,
      capabilities: { pauseResume: false, workspaceCache: false },
      create: async () => assert.fail("create must not be called"),
      connect: async (ref, options) => {
        connects.push([ref, options]);
        return createFakeSandboxHandle({ ref });
      },
    },
  };
}

test("a legacy Cloudflare Session without sandbox_ref uses its Session id", async () => {
  const { provider, connects } = recordingProvider("cloudflare");
  const handle = await connectSandboxHandle({
    meta: { session_id: "ses_legacy" },
    provider,
    readSecret: async () => undefined,
  });
  assert.deepEqual(handle.ref, { provider: "cloudflare", id: "ses_legacy" });
  assert.deepEqual(connects, [[{ provider: "cloudflare", id: "ses_legacy" }, undefined]]);
});

test("an e2b Session without sandbox_ref has no sandbox yet", async () => {
  const { provider, connects } = recordingProvider("e2b");
  assert.equal(sandboxRefForMeta({ session_id: "ses_1" }, provider), null);
  const handle = await connectSandboxHandle({
    meta: { session_id: "ses_1" },
    provider,
    readSecret: async () => assert.fail("must not read the secret without a ref"),
  });
  assert.equal(handle, null);
  assert.deepEqual(connects, []);
});

test("a Session without meta has no sandbox", () => {
  assert.equal(sandboxRefForMeta(null, { name: "cloudflare" }), null);
});

test("an explicit sandbox_ref wins and the stored secret is passed to connect", async () => {
  const { provider, connects } = recordingProvider("e2b");
  const ref = { provider: "e2b", id: "sbx_1" };
  await connectSandboxHandle({
    meta: { session_id: "ses_1", sandbox_ref: ref },
    provider,
    readSecret: async () => "traffic-token",
  });
  assert.deepEqual(connects, [[ref, { secret: "traffic-token" }]]);
});

test("destroySandbox destroys the resolved handle with the reason", async () => {
  const reasons = [];
  const handle = createFakeSandboxHandle({ destroy: async (reason) => { reasons.push(reason); } });
  await destroySandbox(async () => handle, "stopped by user", () => assert.fail("no error expected"));
  assert.deepEqual(reasons, ["stopped by user"]);
});

test("destroySandbox is a no-op without a handle and reports failures instead of throwing", async () => {
  await destroySandbox(async () => null, "x", () => assert.fail("no error expected"));

  const errors = [];
  const handle = createFakeSandboxHandle({ destroy: async () => { throw new Error("stop failed"); } });
  await destroySandbox(async () => handle, "x", (error) => errors.push(error.message));
  await destroySandbox(async () => { throw new Error("connect failed"); }, "x", (error) => errors.push(error.message));
  assert.deepEqual(errors, ["stop failed", "connect failed"]);
});

test("readRedactedAgentLogs redacts and returns null on failure", async () => {
  const handle = createFakeSandboxHandle({
    readProcessLogs: async (id) => ({ stdout: `${id} ${secret}`, stderr: "" }),
  });
  assert.deepEqual(
    await readRedactedAgentLogs(async () => handle, [secret]),
    { stdout: "codevil-agent [REDACTED]", stderr: "" },
  );
  assert.equal(await readRedactedAgentLogs(async () => null, [secret]), null);
  assert.equal(await readRedactedAgentLogs(async () => { throw new Error("x"); }, [secret]), null);
});

test("logs response redacts deployment secrets with status 200", async () => {
  const handle = createFakeSandboxHandle({
    readProcessLogs: async () => ({ stdout: `stdout ${secret}`, stderr: `stderr ${secret}` }),
  });
  const response = await sandboxLogsResponse(async () => handle, [secret]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { stdout: "stdout [REDACTED]", stderr: "stderr [REDACTED]" });
});

test("logs response is a 500 with the legacy body when no sandbox or read fails", async () => {
  for (const resolve of [
    async () => null,
    async () => createFakeSandboxHandle({ readProcessLogs: async () => { throw new Error(secret); } }),
  ]) {
    const response = await sandboxLogsResponse(resolve, [secret]);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Failed to read sandbox logs" });
  }
});

test("diagnostics response redacts secrets and tolerates hostile errors", async () => {
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("must not read hostile error");
    },
  });
  const handle = createFakeSandboxHandle({
    readProcessLogs: async () => ({ stdout: `stdout ${secret}`, stderr: `stderr ${secret}` }),
    readLifecycle: async () => ({ lastEvent: { type: "error", at: "2026-07-10", error: secret } }),
  });
  const response = await sandboxDiagnosticsResponse(async () => handle, [secret]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  assert.match(JSON.stringify(body), /\[REDACTED\]/);
  assert.equal(body.logs.stdout, "stdout [REDACTED]");
  assert.equal(body.lifecycle.lastEvent.error, "[REDACTED]");

  const failing = createFakeSandboxHandle({ readProcessLogs: async () => { throw hostile; } });
  const partial = await sandboxDiagnosticsResponse(async () => failing, [secret]);
  assert.equal(partial.status, 200);
  assert.equal((await partial.json()).logs, null);
});

test("diagnostics response is a 500 with the legacy body when no sandbox exists", async () => {
  const response = await sandboxDiagnosticsResponse(async () => null, [secret]);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Failed to read sandbox diagnostics" });
});
