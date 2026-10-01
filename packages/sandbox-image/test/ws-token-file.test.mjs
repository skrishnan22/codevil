import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSandboxWsTokenSource,
  readTokenFile,
  withSandboxWebSocketToken,
} from "../dist/entrypoint.js";

const BASE = "wss://w/sessions/ses_1/sandbox/ws?sandbox_ws_token=old";
const tokenOf = (url) => new URL(url).searchParams.get("sandbox_ws_token");

test("token source follows file/in-memory precedence across reconnects", () => {
  let fileContent;
  const source = createSandboxWsTokenSource(() => fileContent);

  // (a) file absent -> unchanged
  let wsUrl = source.applyTo(BASE);
  assert.equal(wsUrl, BASE);

  // (b) first non-empty file value is adopted
  fileContent = "file-1\n";
  wsUrl = source.applyTo(wsUrl);
  assert.equal(tokenOf(wsUrl), "file-1");

  // (c) newer in-memory token (proxy_capabilities) wins over an unchanged file
  wsUrl = withSandboxWebSocketToken(wsUrl, "memory-2");
  wsUrl = source.applyTo(wsUrl);
  assert.equal(tokenOf(wsUrl), "memory-2");

  // (d) a changed file value is adopted again
  fileContent = "file-3\n";
  wsUrl = source.applyTo(wsUrl);
  assert.equal(tokenOf(wsUrl), "file-3");

  // (e) whitespace-only file is ignored
  fileContent = "  \n";
  assert.equal(source.applyTo(wsUrl), wsUrl);
});

test("readTokenFile reads a file and returns undefined for a missing path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-token-"));
  const path = join(dir, "ws-token");
  writeFileSync(path, "fresh\n");
  assert.equal(readTokenFile(path)?.trim(), "fresh");
  assert.equal(readTokenFile(join(dir, "missing")), undefined);
});
