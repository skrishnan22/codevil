import assert from "node:assert/strict";
import test from "node:test";
import { createE2BSandboxProvider, E2B_TRAFFIC_TOKEN_HEADER } from "../dist/sandbox-provider/e2b.js";
import { SandboxNotFoundError } from "../dist/sandbox-provider/types.js";
import { collectWorkerSecretValues } from "../dist/worker-env.js";
import { configuredSandboxProviderName, e2bMaxLeaseMs, resolveSandboxProvider } from "../dist/sandbox-provider/index.js";

class NotFound extends Error {}

class CommandExit extends Error {
  constructor(exitCode, stdout, stderr) {
    super("exit");
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function fakeSdk(options = {}) {
  const log = [];
  const files = new Map();
  const sandbox = {
    sandboxId: "sbx_1",
    trafficAccessToken: "tat_secret",
    getHost: (port) => `${port}-sbx_1.e2b.app`,
    commands: {
      run: async (cmd, opts) => {
        log.push(["run", cmd, opts]);
        if (options.run) return options.run(cmd, opts);
        if (opts?.background) return { disconnect: async () => { log.push(["disconnect"]); } };
        if (cmd.startsWith("tail -c 65536 /var/log/codevil/codevil-agent.out")) return { stdout: "agent out", stderr: "", exitCode: 0 };
        if (cmd.startsWith("tail -c 65536 /var/log/codevil/codevil-agent.err")) return { stdout: "agent err", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    files: { write: async (path, content, opts) => { files.set(path, content); log.push(["write", path, opts]); } },
    setTimeout: async (ms) => { log.push(["setTimeout", ms]); },
    pause: async () => { log.push(["pause"]); },
    kill: async () => { log.push(["kill"]); if (options.killError) throw options.killError; },
  };
  const sdk = {
    create: async (template, opts) => { log.push(["create", template, opts]); return sandbox; },
    connect: async (id, opts) => {
      log.push(["connect", id, opts]);
      if (id === "gone") throw new NotFound("sandbox gone");
      return sandbox;
    },
    isNotFound: (error) => error instanceof NotFound,
  };
  return { sdk, log, files, sandbox };
}

function provider(overrides = {}, sdkOptions = {}) {
  const fake = fakeSdk(sdkOptions);
  const fetchCalls = [];
  const p = createE2BSandboxProvider({
    apiKey: "e2b_key", templateId: "codevil-sandbox", maxLeaseMs: 3_600_000, sdk: fake.sdk,
    fetch: async (request) => { fetchCalls.push(request); return new Response("preview"); },
    ...overrides,
  });
  return { p, fake, fetchCalls };
}

test("create locks public traffic, caps the lease, and returns the traffic token as the secret", async () => {
  const { p, fake } = provider();
  const handle = await p.create({ sessionId: "ses_1", leaseMs: 7_200_000 });
  assert.deepEqual(handle.ref, { provider: "e2b", id: "sbx_1" });
  assert.equal(handle.secret, "tat_secret");
  assert.deepEqual(fake.log[0], ["create", "codevil-sandbox", {
    apiKey: "e2b_key", timeoutMs: 3_600_000,
    network: { allowPublicTraffic: false },
    metadata: { codevil_session_id: "ses_1" },
  }]);
  assert.deepEqual(p.capabilities, { pauseResume: true, workspaceCache: false });
});

test("create keeps a lease below the cap", async () => {
  const { p, fake } = provider();
  await p.create({ sessionId: "ses_1", leaseMs: 600_000 });
  assert.equal(fake.log[0][2].timeoutMs, 600_000);
});

test("create fails closed when E2B returns no traffic token", async () => {
  const { p, fake } = provider();
  delete fake.sandbox.trafficAccessToken;
  await assert.rejects(p.create({ sessionId: "ses_1", leaseMs: 600_000 }), /traffic access token/);
  assert.deepEqual(fake.log.at(-1), ["kill"]);
});

test("create reports a failed cleanup kill without leaking secrets", async () => {
  const { p, fake } = provider();
  delete fake.sandbox.trafficAccessToken;
  fake.sandbox.kill = async () => { throw new Error("kill failed e2b_key"); };
  await assert.rejects(p.create({ sessionId: "ses_1", leaseMs: 600_000 }), (error) => {
    assert.equal(error.message, "E2B sandbox was created without a traffic access token (cleanup kill also failed)");
    return true;
  });
});

test("connect maps not-found to SandboxNotFoundError", async () => {
  const { p } = provider();
  await assert.rejects(p.connect({ provider: "e2b", id: "gone" }), SandboxNotFoundError);
});

test("connect rethrows other errors and caps the lease", async () => {
  const { p, fake } = provider();
  fake.sdk.connect = async () => { throw new Error("boom"); };
  await assert.rejects(p.connect({ provider: "e2b", id: "sbx_1" }), /boom/);
  const second = provider();
  await second.p.connect({ provider: "e2b", id: "sbx_1" }, { leaseMs: 9_000_000 });
  await second.p.connect({ provider: "e2b", id: "sbx_1" });
  assert.equal(second.fake.log[0][2].timeoutMs, 3_600_000);
  assert.equal(second.fake.log[1][2].timeoutMs, undefined);
});

test("connect uses the passed secret, else the repopulated traffic token", async () => {
  const { p } = provider();
  assert.equal((await p.connect({ provider: "e2b", id: "sbx_1" }, { secret: "stored" })).secret, "stored");
  assert.equal((await p.connect({ provider: "e2b", id: "sbx_1" })).secret, "tat_secret");
});

test("fetchPort targets the E2B host with the traffic token and keeps path and query", async () => {
  const { p, fetchCalls } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" }, { secret: "tat_secret" });
  await handle.fetchPort(5173, new Request("http://localhost/src/main.ts?t=1", {
    headers: { host: "localhost:5173", upgrade: "websocket", [E2B_TRAFFIC_TOKEN_HEADER]: "client-supplied" },
  }));
  assert.equal(fetchCalls[0].url, "https://5173-sbx_1.e2b.app/src/main.ts?t=1");
  assert.equal(fetchCalls[0].headers.get(E2B_TRAFFIC_TOKEN_HEADER), "tat_secret");
  assert.equal(fetchCalls[0].headers.get("upgrade"), "websocket");
  assert.equal(fetchCalls[0].redirect, "manual");
});

test("fetchPort forwards method, body and abort signal", async () => {
  const { p, fetchCalls } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  const controller = new AbortController();
  await handle.fetchPort(3000, new Request("http://localhost/api", { method: "POST", body: "payload", signal: controller.signal }));
  assert.equal(fetchCalls[0].method, "POST");
  assert.equal(await fetchCalls[0].text(), "payload");
  controller.abort();
  assert.equal(fetchCalls[0].signal.aborted, true);
});

test("fetchPort without a traffic token fails closed and never calls fetch", async () => {
  const { p, fake, fetchCalls } = provider();
  delete fake.sandbox.trafficAccessToken;
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await assert.rejects(
    handle.fetchPort(5173, new Request("http://localhost/", { headers: { [E2B_TRAFFIC_TOKEN_HEADER]: "client-supplied" } })),
    /E2B sandbox traffic token is unavailable/,
  );
  assert.deepEqual(fetchCalls, []);
});

test("startProcess redirects output to per-process log files and readProcessLogs tails them", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.startProcess("node /app/x.js --name 'a b'", { processId: "codevil-agent", cwd: "/workspace", env: { A: "1" } });
  const background = fake.log.find(([kind, , opts]) => kind === "run" && opts?.background);
  assert.match(background[1], /^sh -c '.*' >\/var\/log\/codevil\/codevil-agent\.out 2>\/var\/log\/codevil\/codevil-agent\.err$/);
  assert.ok(background[1].includes(`node /app/x.js --name '\\''a b'\\''`));
  assert.deepEqual(background[2], { background: true, user: "root", cwd: "/workspace", envs: { A: "1" } });
  const mkdirIndex = fake.log.findIndex(([, cmd]) => cmd === "mkdir -p /var/log/codevil");
  assert.ok(mkdirIndex >= 0 && mkdirIndex < fake.log.indexOf(background));
  assert.deepEqual(fake.log[fake.log.indexOf(background) + 1], ["disconnect"]);
  assert.deepEqual(await handle.readProcessLogs("codevil-agent"), { stdout: "agent out", stderr: "agent err" });
  await assert.rejects(handle.startProcess("x", { processId: "../etc", cwd: "/", env: {} }));
  await assert.rejects(handle.readProcessLogs("../etc"));
});

test("writeFile stages as root, permissions the staged file, then renames over the target", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.writeFile("/run/codevil/ws-token", "tok", { mode: 0o600, owner: "codevil" });
  const writeIndex = fake.log.findIndex(([kind]) => kind === "write");
  const [, stage, writeOptions] = fake.log[writeIndex];
  assert.match(stage, /^\/run\/\.codevil-stage\/[0-9a-f-]{36}$/);
  assert.deepEqual(writeOptions, { user: "root" });
  assert.equal(fake.files.get(stage), "tok");
  assert.equal(fake.files.has("/run/codevil/ws-token"), false);
  assert.equal(fake.log[writeIndex - 1][1], "mkdir -p -m 700 /run/.codevil-stage && chmod 700 /run/.codevil-stage && chown 0:0 /run/.codevil-stage");
  assert.equal(
    fake.log[writeIndex + 1][1],
    `chmod 600 '${stage}' && chown 10001:10001 '${stage}' && mkdir -p '/run/codevil' && mv -fT '${stage}' '/run/codevil/ws-token'`,
  );
});

test("writeFile quotes hostile paths and skips chmod/chown when not requested", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.writeFile("/run/it's/x y", "tok");
  const final = fake.log.at(-1)[1];
  assert.match(final, /^mkdir -p '\/run\/it'\\''s' && mv -fT '\/run\/\.codevil-stage\/[0-9a-f-]{36}' '\/run\/it'\\''s\/x y'$/);
});

test("writeFile throws on any failing step and removes the staged file", async () => {
  const commands = [];
  const { p } = provider({}, {
    run: async (cmd) => {
      commands.push(cmd);
      return cmd.includes("mv -fT") ? { stdout: "", stderr: "denied", exitCode: 1 } : { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await assert.rejects(handle.writeFile("/x", "y", { mode: 0o600 }), /Failed to write \/x \(exit 1\): denied/);
  assert.match(commands.at(-1), /^rm -f '\/run\/\.codevil-stage\//);
  const prep = provider({}, { run: async () => ({ stdout: "", stderr: "ro fs", exitCode: 1 }) });
  const h2 = await prep.p.connect({ provider: "e2b", id: "sbx_1" });
  await assert.rejects(h2.writeFile("/x", "y"), /Failed to prepare staging for \/x \(exit 1\): ro fs/);
  assert.equal(prep.fake.files.size, 0);
});

test("exec, writeFile and startProcess map not-found to SandboxNotFoundError", async () => {
  const gone = () => { throw new NotFound("gone"); };
  const viaRun = provider({}, { run: gone });
  const h1 = await viaRun.p.connect({ provider: "e2b", id: "sbx_1" });
  await assert.rejects(h1.exec("echo"), SandboxNotFoundError);

  const viaWrite = provider();
  const h2 = await viaWrite.p.connect({ provider: "e2b", id: "sbx_1" });
  viaWrite.fake.sandbox.files.write = gone;
  await assert.rejects(h2.writeFile("/run/x", "y"), SandboxNotFoundError);

  const viaBackground = provider({}, {
    run: async (cmd, opts) => { if (opts?.background) gone(); return { stdout: "", stderr: "", exitCode: 0 }; },
  });
  const h3 = await viaBackground.p.connect({ provider: "e2b", id: "sbx_1" });
  await assert.rejects(h3.startProcess("x", { processId: "p", cwd: "/", env: {} }), SandboxNotFoundError);
});

test("E2B_MAX_SANDBOX_SECONDS is clamped to a positive whole number", () => {
  const ms = (value) => e2bMaxLeaseMs({ E2B_MAX_SANDBOX_SECONDS: value });
  assert.equal(ms(undefined), 3_600_000);
  assert.equal(ms(""), 3_600_000);
  assert.equal(ms("abc"), 3_600_000);
  assert.equal(ms("Infinity"), 3_600_000);
  assert.equal(ms("0"), 3_600_000);
  assert.equal(ms("-5"), 3_600_000);
  assert.equal(ms("0.5"), 3_600_000);
  assert.equal(ms("90.9"), 90_000);
  assert.equal(ms("1800"), 1_800_000);
});

test("exec maps users and options, and turns a command exit error into a result", async () => {
  const { p, fake } = provider({}, {
    run: async (cmd) => {
      if (cmd === "false") throw new CommandExit(3, "out", "err");
      if (cmd === "hang") throw new Error("timed out");
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.exec("echo", { cwd: "/w", env: { A: "1" }, timeoutMs: 5, user: "codevil" });
  await handle.exec("echo");
  assert.deepEqual(fake.log.filter(([kind]) => kind === "run").map(([, , opts]) => opts), [
    { cwd: "/w", envs: { A: "1" }, timeoutMs: 5, user: "codevil" },
    { user: "root" },
  ]);
  assert.deepEqual(await handle.exec("false"), { stdout: "out", stderr: "err", exitCode: 3 });
  await assert.rejects(handle.exec("hang"), /timed out/);
});

test("renewLease caps at the provider maximum; pause and destroy delegate", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.renewLease(9_999_999);
  await handle.pause();
  await handle.destroy("done");
  assert.deepEqual(fake.log.slice(-3), [["setTimeout", 3_600_000], ["pause"], ["kill"]]);
});

test("destroy treats not-found as success and rethrows other errors", async () => {
  const gone = provider({}, { killError: new NotFound("gone") });
  await (await gone.p.connect({ provider: "e2b", id: "sbx_1" })).destroy("done");
  const broken = provider({}, { killError: new Error("boom") });
  await assert.rejects((await broken.p.connect({ provider: "e2b", id: "sbx_1" })).destroy("done"), /boom/);
});

test("renewLease and pause map not-found to SandboxNotFoundError", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  fake.sandbox.setTimeout = async () => { throw new NotFound("gone"); };
  fake.sandbox.pause = async () => { throw new NotFound("gone"); };
  await assert.rejects(handle.renewLease(1_000), SandboxNotFoundError);
  await assert.rejects(handle.pause(), SandboxNotFoundError);
});

test("E2B key is a redacted worker secret and e2b is the default provider", () => {
  assert.ok(collectWorkerSecretValues({ E2B_API_KEY: "e2b_key" }).includes("e2b_key"));
  assert.equal(configuredSandboxProviderName({}), "e2b");
  assert.throws(() => resolveSandboxProvider({ Sandbox: {} }, "e2b"), /E2B_API_KEY is not configured/);
});

test("resolveSandboxProvider builds the e2b provider from env", () => {
  const provider = resolveSandboxProvider({ Sandbox: {}, E2B_API_KEY: "e2b_key" }, "e2b");
  assert.equal(provider.name, "e2b");
});
