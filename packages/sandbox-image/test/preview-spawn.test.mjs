import assert from "node:assert/strict";
import test from "node:test";

import {
  PreviewCommandRejectedError,
  previewProcessEnv,
  resolvePreviewSpawn,
  tokenizeCommandLine,
} from "../dist/preview-spawn.js";

test("tokenizeCommandLine respects quoted segments", () => {
  assert.deepEqual(
    tokenizeCommandLine('pnpm run dev -- --host "0.0.0.0" --port 5173'),
    ["pnpm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"],
  );
});

test("resolvePreviewSpawn accepts package-manager dev commands", () => {
  const spawn = resolvePreviewSpawn("pnpm run dev -- --host 0.0.0.0 --port 5173");
  assert.equal(spawn.executable, "pnpm");
  assert.deepEqual(spawn.argv, ["run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]);
});

test("resolvePreviewSpawn rejects shell metacharacters", () => {
  assert.throws(
    () => resolvePreviewSpawn("pnpm run dev; rm -rf /"),
    PreviewCommandRejectedError,
  );
});

test("resolvePreviewSpawn rejects non-allowlisted executables", () => {
  assert.throws(
    () => resolvePreviewSpawn("bash -c 'echo hi'"),
    /not allowlisted/i,
  );
});

test("resolvePreviewSpawn accepts node one-liners", () => {
  const spawn = resolvePreviewSpawn(
    "node -e \"require('net').createServer(() => {}).listen(59997, '127.0.0.1')\"",
  );
  assert.equal(spawn.executable, "node");
  assert.equal(spawn.argv[0], "-e");
});

test("previewProcessEnv allows the E2B preview host for Vite only on the e2b provider", () => {
  const e2b = previewProcessEnv({ CODEVIL_SANDBOX_PROVIDER: "e2b", KEEP: "1" }, 5173);
  assert.equal(e2b.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, ".e2b.app");
  assert.equal(e2b.PORT, "5173");
  assert.equal(e2b.HOST, "0.0.0.0");
  assert.equal(e2b.KEEP, "1");

  for (const provider of ["cloudflare", undefined]) {
    const env = previewProcessEnv(provider ? { CODEVIL_SANDBOX_PROVIDER: provider } : {}, 3000);
    assert.equal("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS" in env, false);
    assert.equal(env.PORT, "3000");
  }
});

test("previewProcessEnv merges with an existing allowed-hosts value without duplicating", () => {
  const merged = previewProcessEnv({
    CODEVIL_SANDBOX_PROVIDER: "e2b",
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "example.test, other.test",
  }, 3000);
  assert.equal(merged.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, "example.test,other.test,.e2b.app");
  const again = previewProcessEnv({
    CODEVIL_SANDBOX_PROVIDER: "e2b",
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app",
  }, 3000);
  assert.equal(again.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, ".e2b.app");
});
