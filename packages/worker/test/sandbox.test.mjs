import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSandboxWebSocketUrl,
  buildSandboxDisconnectLogPayload,
  CODEVIL_SANDBOX_OPTIONS,
  collectSandboxDiagnostics,
  getCodevilSandbox,
  lifecycleErrorEvent,
  recordSandboxLifecycleEvent,
  redactSandboxKeepAliveState,
  retrySandboxOperation,
  SANDBOX_LIFECYCLE_EVENT_KEY,
  sandboxProcessEnv,
  setCodevilSandboxKeepAlive,
  shouldDeferSandboxActivityExpiry,
  stopDiagnostics,
} from "../dist/sandbox.js";

test("builds sandbox WebSocket URL from worker origin", () => {
  assert.equal(
    buildSandboxWebSocketUrl("https://codevil.example.com/sessions", "ses_123"),
    "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
  );
});

test("builds sandbox process env with only short-lived per-Pi-API proxy capabilities", () => {
  assert.deepEqual(sandboxProcessEnv({
    wsUrl: "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
    wsToken: "sandbox-ws-capability",
    provider: "anthropic",
    proxyBase: "https://codevil.example.com",
    proxyTokens: { "anthropic-messages": "sandbox-capability" },
  }), {
    CODEVIL_DO_WS_URL: "wss://codevil.example.com/sessions/ses_123/sandbox/ws?sandbox_ws_token=sandbox-ws-capability",
    CODEVIL_SANDBOX_WS_TOKEN: "sandbox-ws-capability",
    CODEVIL_WORKSPACE: "/workspace",
    CODEVIL_PROVIDER: "anthropic",
    CODEVIL_PROXY_BASE: "https://codevil.example.com",
    CODEVIL_PROXY_TOKENS: '{"anthropic-messages":"sandbox-capability"}',
  });
});

test("sandbox process environment never receives the deployment API key or provider credential", () => {
  const env = sandboxProcessEnv({
    wsUrl: "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
    wsToken: "session-bound-ws-capability",
    provider: "anthropic",
    proxyBase: "https://codevil.example.com",
    proxyTokens: { "anthropic-messages": "proxy-capability" },
  });
  assert.equal(env.CODEVIL_API_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(env), /sk-ant-real-provider-key/);
});

test("sandbox process environment carries Cloudflare identifiers only in the allowlisted provider config payload", () => {
  const env = sandboxProcessEnv({
    wsUrl: "wss://codevil.example.com/sessions/ses_123/sandbox/ws",
    wsToken: "session-bound-ws-capability",
    provider: "cloudflare-ai-gateway",
    providerConfig: {
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      CLOUDFLARE_GATEWAY_ID: "gateway_456",
    },
    proxyBase: "https://codevil.example.com",
    proxyTokens: { "anthropic-messages": "proxy-capability" },
  });

  assert.equal(
    env.CODEVIL_PROVIDER_CONFIG,
    '{"CLOUDFLARE_ACCOUNT_ID":"account_123","CLOUDFLARE_GATEWAY_ID":"gateway_456"}',
  );
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(env.CLOUDFLARE_GATEWAY_ID, undefined);
  assert.equal(env.CLOUDFLARE_API_KEY, undefined);
});

test("gets codevil sandbox with keepAlive enabled", () => {
  const binding = {};
  const sandbox = {};
  const calls = [];

  const result = getCodevilSandbox((actualBinding, sessionId, options) => {
    calls.push({ binding: actualBinding, sessionId, options });
    return sandbox;
  }, binding, "ses_123");

  assert.equal(result, sandbox);
  assert.deepEqual(calls, [{
    binding,
    sessionId: "ses_123",
    options: CODEVIL_SANDBOX_OPTIONS,
  }]);
  assert.equal(CODEVIL_SANDBOX_OPTIONS.keepAlive, true);
});

test("records sandbox lifecycle events for stop diagnostics", async () => {
  const writes = [];
  const storage = {
    put: async (key, value) => {
      writes.push({ key, value });
    },
  };

  await recordSandboxLifecycleEvent(storage, {
    type: "stop",
    at: "2026-06-16T00:00:00.000Z",
    exit_code: 137,
    reason: "out of memory",
  }, []);

  assert.deepEqual(writes, [{
    key: SANDBOX_LIFECYCLE_EVENT_KEY,
    value: {
      type: "stop",
      at: "2026-06-16T00:00:00.000Z",
      exit_code: 137,
      reason: "out of memory",
    },
  }]);
});

test("redacts lifecycle values before persisting stop diagnostics or keepalive state", async () => {
  const secret = "sandbox-lifecycle-storage-secret";
  const writes = [];
  const storage = { put: async (key, value) => writes.push({ key, value }) };

  await recordSandboxLifecycleEvent(storage, {
    type: "stop",
    at: "2026-06-16T00:00:00.000Z",
    reason: `container stopped with ${secret}`,
  }, [secret]);

  assert.deepEqual(writes[0].value, {
    type: "stop",
    at: "2026-06-16T00:00:00.000Z",
    reason: "container stopped with [REDACTED]",
  });
  assert.deepEqual(redactSandboxKeepAliveState({
    active: true,
    reason: `working with ${secret}`,
  }, [secret]), {
    active: true,
    reason: "working with [REDACTED]",
  });
});

test("lifecycle errors and stop diagnostics do not invoke hostile accessors", () => {
  const secret = "sandbox-lifecycle-secret";
  const hostileError = {};
  Object.defineProperty(hostileError, "message", {
    get() {
      throw new Error("must not read lifecycle message");
    },
  });
  const hostileStop = {};
  Object.defineProperty(hostileStop, "reason", {
    get() {
      throw new Error("must not read stop reason");
    },
  });
  Object.defineProperty(hostileStop, "exitCode", { value: 137 });

  assert.doesNotThrow(() => lifecycleErrorEvent(hostileError, [secret]));
  assert.equal(lifecycleErrorEvent(new Error(`failed ${secret}`), [secret]).error, "failed [REDACTED]");
  assert.deepEqual(stopDiagnostics(hostileStop), { exit_code: 137 });
});

test("defers activity expiry while codevil keepalive is active", () => {
  assert.equal(shouldDeferSandboxActivityExpiry({ active: true }), true);
  assert.equal(shouldDeferSandboxActivityExpiry({ active: false }), false);
  assert.equal(shouldDeferSandboxActivityExpiry(undefined), false);
});

test("sets both cloudflare and codevil sandbox keepalive flags when available", async () => {
  const calls = [];
  const sandbox = {
    setKeepAlive: async (active) => {
      calls.push(["cloudflare", active]);
    },
    setCodevilKeepAlive: async (active, reason) => {
      calls.push(["codevil", active, reason]);
    },
  };

  await setCodevilSandboxKeepAlive(sandbox, false, "timed out");

  assert.deepEqual(calls, [
    ["cloudflare", false],
    ["codevil", false, "timed out"],
  ]);
});

test("collects sandbox diagnostics from logs and lifecycle storage", async () => {
  const diagnostics = await collectSandboxDiagnostics({
    getProcessLogs: async (processId) => {
      assert.equal(processId, "codevil-agent");
      return { stdout: "out", stderr: "err" };
    },
    getCodevilLifecycleSnapshot: async () => ({
      keepAlive: {
        active: true,
        reason: "session provisioning",
        updated_at: "2026-06-16T00:00:00.000Z",
      },
      lastEvent: {
        type: "activity_expired_deferred",
        at: "2026-06-16T00:10:00.000Z",
        reason: "session provisioning",
      },
    }),
  }, "codevil-agent", []);

  assert.deepEqual(diagnostics, {
    logs: { stdout: "out", stderr: "err" },
    lifecycle: {
      keepAlive: {
        active: true,
        reason: "session provisioning",
        updated_at: "2026-06-16T00:00:00.000Z",
      },
      lastEvent: {
        type: "activity_expired_deferred",
        at: "2026-06-16T00:10:00.000Z",
        reason: "session provisioning",
      },
    },
  });
});

test("redacts successful sandbox process output before diagnostic callers can broadcast it", async () => {
  const secret = "sandbox-timeout-output-secret";
  const diagnostics = await collectSandboxDiagnostics({
    getProcessLogs: async () => ({
      stdout: `stdout ${secret}`,
      stderr: `stderr ${secret}`,
    }),
  }, "codevil-agent", [secret]);

  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[REDACTED\]/);
});

test("returns lifecycle diagnostics when process logs fail", async () => {
  const diagnostics = await collectSandboxDiagnostics({
    getProcessLogs: async () => {
      throw new Error("process not found");
    },
    getCodevilLifecycleSnapshot: async () => ({
      lastEvent: {
        type: "stop",
        at: "2026-06-16T00:11:00.000Z",
        exit_code: 137,
        reason: "out of memory",
      },
    }),
  }, "codevil-agent", []);

  assert.deepEqual(diagnostics, {
    logs: null,
    lifecycle: {
      lastEvent: {
        type: "stop",
        at: "2026-06-16T00:11:00.000Z",
        exit_code: 137,
        reason: "out of memory",
      },
    },
    errors: {
      logs: "process not found",
    },
  });
});

test("sanitizes rejected sandbox diagnostics without invoking hostile getters or coercion", async () => {
  const secret = "sandbox-rejection-secret";
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() { throw new Error("must not read message"); },
  });
  Object.defineProperty(hostile, "toString", {
    value() { throw new Error("must not coerce error"); },
  });

  const diagnostics = await collectSandboxDiagnostics({
    getProcessLogs: async () => { throw new Error(`logs ${secret}`); },
    getCodevilLifecycleSnapshot: async () => { throw hostile; },
  }, "codevil-agent", [secret]);

  assert.deepEqual(diagnostics, {
    logs: null,
    lifecycle: null,
    errors: { logs: "logs [REDACTED]", lifecycle: "[UNAVAILABLE]" },
  });
});

test("builds bounded sandbox disconnect log payload with actual diagnostics", () => {
  const payload = buildSandboxDisconnectLogPayload({
    sessionId: "ses_123",
    closeCode: 1006,
    closeReason: "",
    state: "executing",
    diagnostics: {
      logs: {
        stdout: `${"a".repeat(5000)}stdout-end`,
        stderr: `line 1\nactual crash: out of memory\n${"b".repeat(5000)}stderr-end`,
      },
      lifecycle: {
        keepAlive: {
          active: true,
          reason: "session provisioning",
          updated_at: "2026-06-16T00:00:00.000Z",
        },
        lastEvent: {
          type: "stop",
          at: "2026-06-16T00:11:00.000Z",
          exit_code: 137,
          reason: "out of memory",
        },
      },
    },
    maxLogChars: 32,
  });

  assert.deepEqual(payload, {
    session_id: "ses_123",
    close_code: 1006,
    close_reason: "none",
    state: "executing",
    lifecycle: {
      keepAlive: {
        active: true,
        reason: "session provisioning",
        updated_at: "2026-06-16T00:00:00.000Z",
      },
      lastEvent: {
        type: "stop",
        at: "2026-06-16T00:11:00.000Z",
        exit_code: 137,
        reason: "out of memory",
      },
    },
    stdout_tail: `${"a".repeat(22)}stdout-end`,
    stderr_tail: `${"b".repeat(22)}stderr-end`,
    stdout_truncated: true,
    stderr_truncated: true,
  });
});

test("includes diagnostic collection errors in sandbox disconnect log payload", () => {
  const payload = buildSandboxDisconnectLogPayload({
    sessionId: "ses_123",
    closeCode: 1011,
    closeReason: "socket error",
    state: "planning",
    diagnostics: {
      logs: null,
      lifecycle: null,
      errors: {
        logs: "process not found",
        lifecycle: "storage unavailable",
      },
    },
  });

  assert.deepEqual(payload, {
    session_id: "ses_123",
    close_code: 1011,
    close_reason: "socket error",
    state: "planning",
    errors: {
      logs: "process not found",
      lifecycle: "storage unavailable",
    },
  });
});

test("retries transient sandbox 503 failures", async () => {
  const sleeps = [];
  let calls = 0;

  const result = await retrySandboxOperation(async () => {
    calls++;
    if (calls === 1) {
      throw new Error("Failed to create session: 503");
    }
    return "started";
  }, {
    attempts: 2,
    baseDelayMs: 25,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });

  assert.equal(result, "started");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [25]);
});

test("retries transient container startup failures", async () => {
  const sleeps = [];
  let calls = 0;

  const result = await retrySandboxOperation(async () => {
    calls++;
    if (calls <= 2) {
      throw new Error("Failed to create session: 500");
    }
    return "started";
  }, {
    attempts: 4,
    baseDelayMs: 25,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });

  assert.equal(result, "started");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [25, 50]);
});

test("does not retry non-transient sandbox failures", async () => {
  let calls = 0;

  await assert.rejects(
    retrySandboxOperation(async () => {
      calls++;
      throw new Error("Permission denied");
    }, {
      attempts: 3,
      baseDelayMs: 25,
      sleep: async () => {},
    }),
    /Permission denied/,
  );

  assert.equal(calls, 1);
});
