import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderCredential } from "../dist/provider-validation.js";

const definition = {
  id: "openai",
  aliases: [],
  displayName: "OpenAI Platform",
  secretName: "OPENAI_API_KEY",
  validationUrl: "https://api.openai.com/v1/models",
  keyHelpUrl: "https://platform.openai.com/api-keys",
};

function createFetchResponse(status) {
  return {
    status,
    text() {
      throw new Error("response body should not be consumed");
    },
    json() {
      throw new Error("response body should not be consumed");
    },
    arrayBuffer() {
      throw new Error("response body should not be consumed");
    },
  };
}

test("sends the expected GET request with bearer authorization", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return createFetchResponse(200);
  };

  const result = await validateProviderCredential(definition, "fake-key", fetcher);

  assert.deepEqual(result, { status: "valid" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, definition.validationUrl);
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.signal instanceof AbortSignal, true);
  assert.deepEqual(Object.fromEntries(new Headers(calls[0].init?.headers).entries()), {
    accept: "application/json",
    authorization: "Bearer fake-key",
  });
});

test("clears the validation deadline after a completed request", async () => {
  const timeoutHandle = Symbol("timeout");
  let clearedHandle;

  const result = await validateProviderCredential(
    definition,
    "fake-key",
    async () => createFetchResponse(200),
    {
      setTimer() {
        return timeoutHandle;
      },
      clearTimer(handle) {
        clearedHandle = handle;
      },
    },
  );

  assert.deepEqual(result, { status: "valid" });
  assert.equal(clearedHandle, timeoutHandle);
});

test("treats any 2xx response as valid", async () => {
  const valid200 = await validateProviderCredential(definition, "fake-key", async () => createFetchResponse(200));
  const valid204 = await validateProviderCredential(definition, "fake-key", async () => createFetchResponse(204));

  assert.deepEqual(valid200, { status: "valid" });
  assert.deepEqual(valid204, { status: "valid" });
});

test("treats 401 and 403 responses as invalid without leaking secrets or bodies", async () => {
  const invalid401 = await validateProviderCredential(definition, "fake-key", async () => createFetchResponse(401));
  const invalid403 = await validateProviderCredential(definition, "fake-key", async () => createFetchResponse(403));

  assert.deepEqual(invalid401, {
    status: "invalid",
    message: "Invalid credential for OpenAI Platform.",
  });
  assert.deepEqual(invalid403, {
    status: "invalid",
    message: "Invalid credential for OpenAI Platform.",
  });
  assert.doesNotMatch(invalid401.message, /fake-key|response body should not be consumed/);
  assert.doesNotMatch(invalid403.message, /fake-key|response body should not be consumed/);
});

test("treats non-auth error responses as unavailable", async () => {
  const unavailable429 = await validateProviderCredential(definition, "fake-key", async () => createFetchResponse(429));
  const unavailable500 = await validateProviderCredential(definition, "fake-key", async () => createFetchResponse(500));

  assert.deepEqual(unavailable429, {
    status: "unavailable",
    message: "Unable to validate OpenAI Platform (status 429).",
  });
  assert.deepEqual(unavailable500, {
    status: "unavailable",
    message: "Unable to validate OpenAI Platform (status 500).",
  });
  assert.doesNotMatch(unavailable429.message, /fake-key|response body should not be consumed/);
  assert.doesNotMatch(unavailable500.message, /fake-key|response body should not be consumed/);
});

test("treats fetch failures as unavailable without leaking secrets", async () => {
  const result = await validateProviderCredential(definition, "fake-key", async () => {
    throw new Error("network down");
  });

  assert.deepEqual(result, {
    status: "unavailable",
    message: "Unable to validate OpenAI Platform.",
  });
  assert.doesNotMatch(result.message, /fake-key|network down/);
});

test("treats an aborted fetch as unavailable without exposing its reason", async () => {
  const result = await validateProviderCredential(definition, "fake-key", async () => {
    throw new DOMException("aborted request carried fake-key", "AbortError");
  });

  assert.deepEqual(result, {
    status: "unavailable",
    message: "Unable to validate OpenAI Platform.",
  });
  assert.doesNotMatch(result.message, /fake-key|abort/i);
});

test("aborts provider validation at its deadline and returns provider-safe text", async () => {
  let requestSignal;
  let fireTimeout;
  let clearedHandle;
  const timeoutHandle = Symbol("timeout");
  const fetcher = async (_url, init) => {
    requestSignal = init?.signal;
    return await new Promise(() => {});
  };

  const pending = validateProviderCredential(
    definition,
    "fake-key",
    fetcher,
    {
      timeoutMs: 5,
      setTimer(callback, delayMs) {
        assert.equal(delayMs, 5);
        fireTimeout = callback;
        return timeoutHandle;
      },
      clearTimer(handle) {
        clearedHandle = handle;
      },
    },
  );
  fireTimeout();
  const result = await pending;

  assert.equal(requestSignal?.aborted, true);
  assert.equal(clearedHandle, timeoutHandle);
  assert.deepEqual(result, {
    status: "unavailable",
    message: "Unable to validate OpenAI Platform.",
  });
  assert.doesNotMatch(result.message, /fake-key|Bearer|abort/i);
});
