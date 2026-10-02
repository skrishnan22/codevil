import assert from "node:assert/strict";
import test from "node:test";

import {
  connectSandboxHandle,
  createSandboxHandleCache,
  destroySandbox,
  loadStoredSandboxSecret,
  readRedactedAgentLogs,
  registerSandboxSecret,
  SANDBOX_SECRET_KEY,
  sandboxDiagnosticsResponse,
  sandboxLogsResponse,
  sandboxRefForMeta,
} from "../dist/orchestrator/sandbox-access.js";
import { SandboxNotFoundError } from "../dist/sandbox-provider/types.js";
import { createFakeSandboxHandle } from "./helpers/fake-host.mjs";

const secret = "diagnostics-response-secret";

function recordingProvider(name) {
  const connects = [];
  return {
    connects,
    provider: {
      name,
      capabilities: { pauseResume: false, workspaceCache: false, leaseRenewal: false },
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

test("registerSandboxSecret adds a trimmed secret once, in place", () => {
  const secrets = ["existing"];
  const same = secrets;
  registerSandboxSecret(secrets, " tat_secret ");
  registerSandboxSecret(secrets, "tat_secret");
  registerSandboxSecret(secrets, undefined);
  registerSandboxSecret(secrets, "  ");
  assert.equal(secrets, same);
  assert.deepEqual(secrets, ["existing", "tat_secret"]);
});

test("loadStoredSandboxSecret restores the persisted secret into the redaction list on cold start", async () => {
  const secrets = ["e2b_key"];
  const reads = [];
  await loadStoredSandboxSecret({
    get: async (key) => { reads.push(key); return "tat_secret"; },
  }, secrets);
  assert.equal(SANDBOX_SECRET_KEY, "codevil:sandbox_secret");
  assert.deepEqual(reads, ["codevil:sandbox_secret"]);
  assert.deepEqual(secrets, ["e2b_key", "tat_secret"]);
  const logs = await sandboxLogsResponse(
    async () => createFakeSandboxHandle({ readProcessLogs: async () => ({ stdout: "token tat_secret", stderr: "key e2b_key" }) }),
    secrets,
  );
  const body = JSON.stringify(await logs.json());
  assert.doesNotMatch(body, /tat_secret|e2b_key/);
  await loadStoredSandboxSecret({ get: async () => undefined }, secrets);
  assert.deepEqual(secrets, ["e2b_key", "tat_secret"]);
});

test("connectSandboxHandle registers and persists a provider-supplied secret when none was stored", async () => {
  const secrets = [];
  const stored = [];
  const provider = { name: "e2b", connect: async () => createFakeSandboxHandle({ secret: "fallback_tat" }) };
  const meta = { session_id: "ses_1", sandbox_ref: { provider: "e2b", id: "sbx_1" } };
  await connectSandboxHandle({
    meta, provider, secrets,
    readSecret: async () => undefined,
    storeSecret: async (secret) => { stored.push(secret); },
  });
  assert.deepEqual(secrets, ["fallback_tat"]);
  assert.deepEqual(stored, ["fallback_tat"]);

  await connectSandboxHandle({
    meta, provider, secrets,
    readSecret: async () => "fallback_tat",
    storeSecret: async (secret) => { stored.push(secret); },
  });
  assert.deepEqual(secrets, ["fallback_tat"]);
  assert.deepEqual(stored, ["fallback_tat"]);
});

const e2bMeta = { session_id: "ses_1", sandbox_ref: { provider: "e2b", id: "sbx_1" } };

function lookup(provider, cache, meta = e2bMeta, extra = {}) {
  return connectSandboxHandle({ meta, provider, readSecret: async () => "tok", cache, ...extra });
}

test("a cached lookup connects once and returns the same handle", async () => {
  const { provider, connects } = recordingProvider("e2b");
  const cache = createSandboxHandleCache();
  const first = await lookup(provider, cache);
  const second = await lookup(provider, cache);
  assert.equal(connects.length, 1);
  assert.equal(first.ref.id, second.ref.id);
});

test("concurrent lookups share a single connect", async () => {
  const { provider, connects } = recordingProvider("e2b");
  const cache = createSandboxHandleCache();
  await Promise.all([lookup(provider, cache), lookup(provider, cache), lookup(provider, cache)]);
  assert.equal(connects.length, 1);
});

test("without a cache every lookup connects", async () => {
  const { provider, connects } = recordingProvider("e2b");
  await lookup(provider, undefined);
  await lookup(provider, undefined);
  assert.equal(connects.length, 2);
});

test("invalidation and a changed sandbox ref both reconnect", async () => {
  const { provider, connects } = recordingProvider("e2b");
  const cache = createSandboxHandleCache();
  await lookup(provider, cache);
  cache.invalidate();
  await lookup(provider, cache);
  assert.equal(connects.length, 2);
  await lookup(provider, cache, { ...e2bMeta, sandbox_ref: { provider: "e2b", id: "sbx_2" } });
  assert.equal(connects.length, 3);
  await lookup(provider, cache, { ...e2bMeta, sandbox_ref: { provider: "e2b", id: "sbx_2" } });
  assert.equal(connects.length, 3);
});

test("a failed connect and a missing sandbox are never cached", async () => {
  let attempts = 0;
  const provider = {
    name: "e2b",
    capabilities: { pauseResume: true, workspaceCache: false, leaseRenewal: true },
    create: async () => assert.fail("create must not be called"),
    connect: async (ref) => {
      attempts += 1;
      if (attempts === 1) throw new Error("connect failed");
      return createFakeSandboxHandle({ ref });
    },
  };
  const cache = createSandboxHandleCache();
  await assert.rejects(lookup(provider, cache), /connect failed/);
  assert.ok(await lookup(provider, cache));
  assert.equal(attempts, 2);
  assert.equal(await lookup(provider, cache, { session_id: "ses_1" }), null);
});

test("a SandboxNotFoundError from any handle call evicts the cached handle", async () => {
  const members = [
    ["exec", (h) => h.exec("x")],
    ["writeFile", (h) => h.writeFile("/x", "y")],
    ["startProcess", (h) => h.startProcess("x", { processId: "p", cwd: "/", env: {} })],
    ["readProcessLogs", (h) => h.readProcessLogs("p")],
    ["fetchPort", (h) => h.fetchPort(1, new Request("http://x/"))],
    ["renewLease", (h) => h.renewLease(1)],
    ["pause", (h) => h.pause()],
    ["destroy", (h) => h.destroy("r")],
    ["readLifecycle", (h) => h.readLifecycle()],
  ];
  for (const [name, call] of members) {
    let connects = 0;
    const provider = {
      name: "e2b",
      capabilities: { pauseResume: true, workspaceCache: false, leaseRenewal: true },
      create: async () => assert.fail("create must not be called"),
      connect: async (ref) => {
        connects += 1;
        return createFakeSandboxHandle({
          ref,
          [name]: async () => { throw new SandboxNotFoundError(); },
          ...(name === "pause" ? {} : { pause: async () => {} }),
          readLifecycle: name === "readLifecycle" ? async () => { throw new SandboxNotFoundError(); } : async () => null,
        });
      },
    };
    const cache = createSandboxHandleCache();
    const handle = await lookup(provider, cache);
    await assert.rejects(call(handle), SandboxNotFoundError, name);
    await lookup(provider, cache);
    assert.equal(connects, 2, `${name} should evict`);
  }
});

test("other handle errors keep the cached handle", async () => {
  let connects = 0;
  const provider = {
    name: "e2b",
    capabilities: { pauseResume: true, workspaceCache: false, leaseRenewal: true },
    create: async () => assert.fail("create must not be called"),
    connect: async (ref) => {
      connects += 1;
      return createFakeSandboxHandle({ ref, exec: async () => { throw new Error("boom"); } });
    },
  };
  const cache = createSandboxHandleCache();
  await assert.rejects((await lookup(provider, cache)).exec("x"), /boom/);
  await lookup(provider, cache);
  assert.equal(connects, 1);
});

test("a cached handle still registers and persists its secret on first connect only", async () => {
  const secrets = [];
  const stored = [];
  const provider = {
    name: "e2b",
    capabilities: { pauseResume: true, workspaceCache: false, leaseRenewal: true },
    create: async () => assert.fail("create must not be called"),
    connect: async (ref) => createFakeSandboxHandle({ ref, secret: "traffic-secret" }),
  };
  const cache = createSandboxHandleCache();
  const options = { secrets, storeSecret: async (value) => { stored.push(value); } };
  for (let i = 0; i < 2; i++) {
    await connectSandboxHandle({ meta: e2bMeta, provider, readSecret: async () => undefined, cache, ...options });
  }
  assert.deepEqual(secrets, ["traffic-secret"]);
  assert.deepEqual(stored, ["traffic-secret"]);
});

test("destroySandbox kills a paused sandbox by reference without resolving a handle", async () => {
  const killed = [];
  await destroySandbox(
    async () => assert.fail("must not connect to a paused sandbox"),
    "stopped",
    () => assert.fail("no error expected"),
    { paused: true, destroyByRef: async () => { killed.push("ref"); } },
  );
  assert.deepEqual(killed, ["ref"]);
});

test("destroySandbox falls back to a kill by reference when connecting fails, and treats not-found as gone", async () => {
  const killed = [];
  const destroyByRef = async () => { killed.push("ref"); };
  await destroySandbox(async () => { throw new Error("connect failed"); }, "x", () => assert.fail("handled"), { destroyByRef });
  assert.deepEqual(killed, ["ref"]);

  await destroySandbox(async () => { throw new SandboxNotFoundError(); }, "x", () => assert.fail("already gone"), { destroyByRef });
  assert.deepEqual(killed, ["ref"]);

  const errors = [];
  await destroySandbox(
    async () => { throw new Error("connect failed"); },
    "x",
    (error) => errors.push(error.message),
    { destroyByRef: async () => { throw new Error("kill failed"); } },
  );
  assert.deepEqual(errors, ["kill failed"]);
});

test("a paused sandbox without a by-reference kill is destroyed through its handle", async () => {
  const reasons = [];
  const handle = createFakeSandboxHandle({ destroy: async (reason) => { reasons.push(reason); } });
  await destroySandbox(async () => handle, "x", () => assert.fail("no error"), { paused: true });
  assert.deepEqual(reasons, ["x"]);
});
