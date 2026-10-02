import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../Dockerfile.sandbox");
const dockerfile = await readFile(dockerfilePath, "utf8");
const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM --platform=$CODEVIL_SANDBOX_PLATFORM"));

test("sandbox runtime preserves Cloudflare backup support and Node development tools", () => {
  assert.match(dockerfile, /^ARG SANDBOX_BASE=docker\.io\/cloudflare\/sandbox:0\.12\.7$/m);
  assert.match(runtime, /^FROM --platform=\$CODEVIL_SANDBOX_PLATFORM \$\{SANDBOX_BASE\}$/m);
  assert.doesNotMatch(runtime, /COPY --from=sandbox-runtime \/container-server\/sandbox \/sandbox/);
  assert.doesNotMatch(runtime, /FROM --platform=\$CODEVIL_SANDBOX_PLATFORM node:22-slim/);
  for (const tool of ["git", "curl", "wget", "jq", "zip", "unzip", "file", "procps"]) {
    assert.match(runtime, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(runtime, /\butil-linux\b/);
  assert.match(runtime, /npm install -g pnpm@10\.28\.1/);
  assert.doesNotMatch(runtime, /npm install -g bun@/);
  assert.match(runtime, /major < 22 \|\| \(major === 22 && minor < 19\)/);
  for (const command of ["git --version", "bun --version", "setpriv --version"]) {
    assert.match(runtime, new RegExp(command));
  }
});

test("sandbox server keeps its supported runtime while Codevil workspace access stays unprivileged", () => {
  assert.match(runtime, /groupadd --gid 10001 codevil/);
  assert.match(
    runtime,
    /useradd --uid 10001 --gid codevil --home-dir \/home\/codevil --create-home codevil/,
  );
  assert.match(runtime, /chown codevil:codevil \/workspace/);
  assert.doesNotMatch(runtime, /chown[^\n]*(?:\/app|\/opt\/codevil)/);
  assert.doesNotMatch(runtime, /\/run\/secrets/);
  assert.doesNotMatch(runtime, /USER codevil/);
  assert.match(runtime, /WORKDIR \/workspace/);
});

test("runtime stage base is configurable and defaults to the Cloudflare sandbox image", () => {
  assert.match(dockerfile, /^ARG SANDBOX_BASE=docker\.io\/cloudflare\/sandbox:0\.12\.7$/m);
  assert.match(dockerfile, /^FROM --platform=\$CODEVIL_SANDBOX_PLATFORM \$\{SANDBOX_BASE\}$/m);
  // The ARG must be declared before the first FROM so the FROM line can expand it.
  assert.ok(dockerfile.indexOf("ARG SANDBOX_BASE=") < dockerfile.indexOf("FROM "));
});

test("runtime stage installs bun when the base image lacks it", () => {
  assert.match(runtime, /command -v bun >\/dev\/null \|\| npm install -g bun/);
});

test("runtime stage prepares the agent log and token directories", () => {
  assert.match(runtime, /mkdir -p \/workspace \/var\/log\/codevil \/run\/codevil/);
  assert.match(runtime, /chown codevil:codevil \/workspace \/run\/codevil/);
});
