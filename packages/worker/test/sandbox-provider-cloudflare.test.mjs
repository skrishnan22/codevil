import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareSandboxProvider } from "../dist/sandbox-provider/cloudflare.js";
import { parseSandboxProviderName, SandboxNotFoundError } from "../dist/sandbox-provider/types.js";
import { sandboxProviderForMeta, configuredSandboxProviderName } from "../dist/sandbox-provider/index.js";

function fakeCloudflareSandbox() {
  const calls = [];
  return {
    calls,
    setKeepAlive: async (active) => { calls.push(["setKeepAlive", active]); },
    setCodevilKeepAlive: async (active, reason) => { calls.push(["setCodevilKeepAlive", active, reason]); },
    startProcess: async (command, options) => { calls.push(["startProcess", command, options]); },
    getProcessLogs: async (id) => ({ stdout: `out:${id}`, stderr: "" }),
    getCodevilLifecycleSnapshot: async () => ({ lastEvent: { type: "start", at: "t" } }),
    fetch: async (request) => { calls.push(["fetch", request.headers.get("cf-container-target-port")]); return new Response("ok"); },
    stop: async () => { calls.push(["stop"]); },
    exec: async (command, options) => { calls.push(["exec", command, options]); return { success: true, exitCode: 0, stdout: "o", stderr: "e" }; },
    writeFile: async (path, content) => { calls.push(["writeFile", path, content]); },
  };
}

function providerWith(sandbox) {
  const seen = [];
  const provider = createCloudflareSandboxProvider({
    binding: {},
    getSandbox: (_binding, id, options) => { seen.push([id, options]); return sandbox; },
  });
  return { provider, seen };
}

test("cloudflare create enables keepalive and uses the session id as the ref", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider, seen } = providerWith(sandbox);
  const handle = await provider.create({ sessionId: "ses_1", leaseMs: 60_000 });
  assert.deepEqual(handle.ref, { provider: "cloudflare", id: "ses_1" });
  assert.deepEqual(seen, [["ses_1", { keepAlive: true }]]);
  assert.deepEqual(sandbox.calls, [["setKeepAlive", true], ["setCodevilKeepAlive", true, "session provisioning"]]);
  assert.deepEqual(provider.capabilities, { pauseResume: false, workspaceCache: true });
  assert.equal(handle.pause, undefined);
  assert.equal(handle.workspaceCache, sandbox);
});

test("cloudflare startProcess keeps processId and autoCleanup", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  await handle.startProcess("node x", { processId: "codevil-agent", cwd: "/workspace", env: { A: "1" } });
  assert.deepEqual(sandbox.calls, [["startProcess", "node x", { cwd: "/workspace", env: { A: "1" }, processId: "codevil-agent", autoCleanup: true }]]);
});

test("cloudflare fetchPort routes by the container target-port header", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  const response = await handle.fetchPort(5173, new Request("http://localhost/"));
  assert.equal(await response.text(), "ok");
  assert.deepEqual(sandbox.calls, [["fetch", "5173"]]);
});

test("cloudflare destroy clears keepalive before stopping", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  await handle.destroy("stopped by user");
  assert.deepEqual(sandbox.calls, [["setKeepAlive", false], ["setCodevilKeepAlive", false, "stopped by user"], ["stop"]]);
});

test("cloudflare readProcessLogs and readLifecycle pass through", async () => {
  const { provider } = providerWith(fakeCloudflareSandbox());
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  assert.deepEqual(await handle.readProcessLogs("codevil-agent"), { stdout: "out:codevil-agent", stderr: "" });
  assert.deepEqual(await handle.readLifecycle(), { lastEvent: { type: "start", at: "t" } });
});

test("cloudflare exec maps options and results", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  const result = await handle.exec("ls", { cwd: "/workspace", env: { A: "1" }, timeoutMs: 5_000 });
  assert.deepEqual(result, { stdout: "o", stderr: "e", exitCode: 0 });
  assert.deepEqual(sandbox.calls, [["exec", "ls", { cwd: "/workspace", env: { A: "1" }, timeout: 5_000 }]]);
});

test("cloudflare writeFile applies mode and owner only when requested", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  await handle.writeFile("/a b", "x");
  await handle.writeFile("/etc/key", "y", { mode: 0o600, owner: "codevil" });
  await handle.writeFile("/etc/root", "z", { owner: "root" });
  assert.deepEqual(sandbox.calls, [
    ["writeFile", "/a b", "x"],
    ["writeFile", "/etc/key", "y"],
    ["exec", "chmod 600 '/etc/key' && chown 10001:10001 '/etc/key'", {}],
    ["writeFile", "/etc/root", "z"],
    ["exec", "chown 0:0 '/etc/root'", {}],
  ]);
});

test("cloudflare renewLease is a no-op", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  await handle.renewLease(1_000);
  assert.deepEqual(sandbox.calls, []);
});

test("provider name parsing and legacy meta default", () => {
  assert.equal(parseSandboxProviderName("e2b"), "e2b");
  assert.equal(parseSandboxProviderName("modal"), undefined);
  assert.equal(new SandboxNotFoundError().name, "SandboxNotFoundError");
  assert.equal(configuredSandboxProviderName({}), "cloudflare");
  assert.throws(() => configuredSandboxProviderName({ SANDBOX_PROVIDER: "modal" }), /Unsupported SANDBOX_PROVIDER/);
  const provider = sandboxProviderForMeta({ Sandbox: {} }, {});
  assert.equal(provider.name, "cloudflare");
});
