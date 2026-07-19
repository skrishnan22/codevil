import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../Dockerfile.sandbox");

test("sandbox runtime preserves Node 22 development tools", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const runtime = dockerfile.split("AS sandbox-runtime")[1];

  assert.ok(runtime, "Dockerfile must define a separate Sandbox entrypoint stage");
  assert.match(runtime, /FROM --platform=\$CODEVIL_SANDBOX_PLATFORM node:22-slim/);
  assert.match(runtime, /COPY --from=sandbox-runtime \/container-server\/sandbox \/sandbox/);
  assert.match(runtime, /ENTRYPOINT \["\/sandbox"\]/);
  for (const tool of ["git", "curl", "wget", "jq", "zip", "unzip", "file", "procps"]) {
    assert.match(runtime, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(runtime, /npm install -g bun@/);
  for (const command of ["node --version", "git --version", "bun --version"]) {
    assert.match(runtime, new RegExp(command));
  }
});

test("sandbox entrypoint and agent processes run as an unprivileged user", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const runtime = dockerfile.split("AS sandbox-runtime")[1];

  assert.match(runtime, /groupadd --gid 10001 codevil/);
  assert.match(runtime, /useradd --uid 10001 --gid codevil --create-home codevil/);
  assert.match(runtime, /chown -R codevil:codevil \/app \/workspace \/opt\/codevil/);
  assert.doesNotMatch(runtime, /\/run\/secrets/);
  assert.match(runtime, /USER codevil\s+WORKDIR \/workspace/);
  assert.doesNotMatch(runtime.slice(runtime.lastIndexOf("USER codevil")), /USER root/);
});
