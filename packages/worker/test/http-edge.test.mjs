import assert from "node:assert/strict";
import test from "node:test";

import { dispatchHttpRequest } from "../dist/http-router.js";
import {
  checkD1Reachable,
  handleHealth,
  handleReady,
} from "../dist/health.js";
import {
  extractSessionIdFromPath,
  handleUncaughtHttpError,
  observeRoutedResponse,
} from "../dist/logging.js";

test("handleHealth returns 200 with ok true", async () => {
  const response = handleHealth();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("dispatchHttpRequest routes GET /health before auth", async () => {
  const response = await dispatchHttpRequest(
    new Request("https://worker.example.com/health"),
    {},
    { withCors: (_request, _env, innerResponse) => innerResponse },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("handleReady returns 200 when all checks pass", async () => {
  const env = {
    CODEVIL_API_KEY: "test-api-key",
    BETTER_AUTH_SECRET: "secret",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    DB: {
      prepare: () => ({
        first: async () => ({ "1": 1 }),
      }),
    },
  };

  const response = await handleReady(env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    checks: { d1: true, auth_config: true, api_key: true },
  });
});

test("handleReady returns 503 when D1 is unreachable", async () => {
  const env = {
    CODEVIL_API_KEY: "test-api-key",
    BETTER_AUTH_SECRET: "secret",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    DB: {
      prepare: () => ({
        first: async () => {
          throw new Error("D1 unavailable");
        },
      }),
    },
  };

  const response = await handleReady(env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    checks: { d1: false, auth_config: true, api_key: true },
  });
});

test("dispatchHttpRequest routes GET /ready with failing D1", async () => {
  const env = {
    CODEVIL_API_KEY: "test-api-key",
    BETTER_AUTH_SECRET: "secret",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    DB: {
      prepare: () => ({
        first: async () => {
          throw new Error("D1 unavailable");
        },
      }),
    },
  };

  const response = await dispatchHttpRequest(
    new Request("https://worker.example.com/ready"),
    env,
    { withCors: (_request, _env, innerResponse) => innerResponse },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    checks: { d1: false, auth_config: true, api_key: true },
  });
});

test("checkD1Reachable returns false when query fails", async () => {
  const db = {
    prepare: () => ({
      first: async () => {
        throw new Error("connection refused");
      },
    }),
  };

  assert.equal(await checkD1Reachable(db), false);
});

test("extractSessionIdFromPath extracts session ids from session routes", () => {
  assert.equal(extractSessionIdFromPath("/sessions/ses_abc123"), "ses_abc123");
  assert.equal(extractSessionIdFromPath("/sessions/ses_abc123/ws"), "ses_abc123");
  assert.equal(extractSessionIdFromPath("/sessions/ses_abc123/logs"), "ses_abc123");
  assert.equal(extractSessionIdFromPath("/sessions"), undefined);
  assert.equal(extractSessionIdFromPath("/health"), undefined);
});

test("observeRoutedResponse passes WebSocket upgrade responses through unchanged", () => {
  const webSocket = { fake: "client-socket" };
  const upgrade = { status: 101, webSocket, headers: new Headers() };

  const result = observeRoutedResponse(upgrade, {
    requestId: "req_ws_test",
    method: "GET",
    path: "/sessions/ses_abc/ws",
    startedAt: Date.now(),
  });

  assert.equal(result, upgrade);
  assert.equal(result.webSocket, webSocket);
  assert.equal(result.headers.get("x-request-id"), null);
});

test("observeRoutedResponse attaches x-request-id to plain API responses", () => {
  const result = observeRoutedResponse(Response.json({ ok: true }), {
    requestId: "req_api_test",
    method: "GET",
    path: "/sessions",
    startedAt: Date.now(),
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-request-id"), "req_api_test");
});

test("handleUncaughtHttpError returns generic 500 without leaking error message", async () => {
  const response = handleUncaughtHttpError(new Error("database password leaked"), {
    requestId: "req_test_123",
    method: "POST",
    path: "/sessions",
    startedAt: Date.now(),
    withCors: (innerResponse) => innerResponse,
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal error" });
  assert.equal(response.headers.get("x-request-id"), "req_test_123");
});
