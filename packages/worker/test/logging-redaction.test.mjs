import assert from "node:assert/strict";
import test from "node:test";

import { setTracerSink } from "@codevil/shared";

import {
  workerLog,
  workerLogException,
  sandboxLifecycleLogger,
} from "../dist/logging.js";
import { handleCreateSession } from "../dist/http-handlers.js";
import { redactSandboxDiagnosticResponse } from "../dist/http-handlers.js";

test("worker logging redacts configured secrets from exceptions and nested sandbox output", () => {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    const secrets = [" short-secret "];
    workerLogException("request.failed", new Error("provider rejected short-secret"), {
      sandbox: {
        stdout: "token=short-secret",
        stderr: "short-secret appeared in stderr",
      },
    }, secrets);
    workerLog("ERROR", "sandbox.logs", {
      diagnostics: { nested: ["short-secret"] },
    }, secrets);
  } finally {
    setTracerSink(() => {});
  }

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, /short-secret/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /provider rejected/);
});

test("worker logging accepts an explicit empty secret context", () => {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    workerLog("ERROR", "sandbox.logs", { api_key: "pre-init-secret" }, []);
  } finally {
    setTracerSink(() => {});
  }

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, /pre-init-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("sandbox lifecycle diagnostics use their explicit deployment secret set", () => {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    sandboxLifecycleLogger(["sandbox-diagnostic-secret"], "session_123").log(
      "ERROR",
      "sandbox.lifecycle",
      { sandbox: { stderr: "failed with sandbox-diagnostic-secret" } },
    );
  } finally {
    setTracerSink(() => {});
  }

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, /sandbox-diagnostic-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("session initialization failure logging redacts Worker deployment secrets", async () => {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    const env = {
      CODEVIL_API_KEY: "worker-deployment-secret",
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({}),
          }),
        }),
        batch: async () => ({}),
      },
      ORCHESTRATOR: {
        idFromName: (name) => name,
        get: () => ({
          init: async () => {
            throw new Error("initialization failed with worker-deployment-secret");
          },
        }),
      },
    };
    const response = await handleCreateSession(
      new Request("https://codevil.example/sessions", {
        method: "POST",
        body: JSON.stringify({ repo: "github.com/acme/app" }),
      }),
      env,
      { userId: "usr_123", email: "owner@example.com", name: "Owner", role: "owner" },
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Failed to initialize session" });
  } finally {
    setTracerSink(() => {});
  }

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, /worker-deployment-secret/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /session\.init\.failed/);
});

test("final logging boundary survives throwing Error getters and redacts Error causes", () => {
  const secret = "boundary-error-secret";
  const cause = new Error(`upstream included ${secret}`);
  cause.detail = `nested ${secret}`;
  const error = new Error(`request included ${secret}`, { cause });
  Object.defineProperty(error, "diagnostic", {
    enumerable: true,
    get() {
      throw new Error("must not read diagnostic getter");
    },
  });

  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    assert.doesNotThrow(() => workerLog("ERROR", "request.failed", { error }, [secret]));
  } finally {
    setTracerSink(() => {});
  }

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, /boundary-error-secret/);
  assert.match(serialized, /request\.failed/);
});

test("final logging boundary never coerces hostile Error fields", () => {
  const error = new Error("safe");
  Object.defineProperty(error, "message", { value: { toString() { throw new Error("must not coerce message"); } } });
  Object.defineProperty(error, "name", { value: { toString() { throw new Error("must not coerce name"); } } });
  Object.defineProperty(error, "stack", { value: { toString() { throw new Error("must not coerce stack"); } } });

  assert.doesNotThrow(() => workerLog("ERROR", "hostile.error", { error }, []));
});

test("sandbox diagnostics responses redact deployment secrets and tolerate hostile errors", () => {
  const secret = "diagnostics-response-secret";
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("must not read hostile error");
    },
  });

  const response = redactSandboxDiagnosticResponse({
    logs: { stdout: `stdout ${secret}`, stderr: `stderr ${secret}` },
    lifecycle: { lastEvent: { type: "error", at: "2026-07-10", error: secret } },
    errors: { logs: hostile },
  }, { CODEVIL_API_KEY: secret });

  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[REDACTED\]/);
});
