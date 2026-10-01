import assert from "node:assert/strict";
import test from "node:test";
import { currentSandboxWebSocketUrl, SANDBOX_WS_TOKEN_FILE } from "../dist/entrypoint.js";

test("uses the token file when present", () => {
  const url = currentSandboxWebSocketUrl("wss://w/sessions/ses_1/sandbox/ws?sandbox_ws_token=old", () => "fresh\n");
  assert.equal(new URL(url).searchParams.get("sandbox_ws_token"), "fresh");
});

test("keeps the in-memory token when the file is missing or empty", () => {
  const base = "wss://w/sessions/ses_1/sandbox/ws?sandbox_ws_token=old";
  assert.equal(currentSandboxWebSocketUrl(base, () => undefined), base);
  assert.equal(currentSandboxWebSocketUrl(base, () => "  "), base);
});

test("token file path is fixed", () => {
  assert.equal(SANDBOX_WS_TOKEN_FILE, "/run/codevil/ws-token");
});
