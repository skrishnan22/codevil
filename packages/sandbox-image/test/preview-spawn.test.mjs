import assert from "node:assert/strict";
import test from "node:test";

import {
  PreviewCommandRejectedError,
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
