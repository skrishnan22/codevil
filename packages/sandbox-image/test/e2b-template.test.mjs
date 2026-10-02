import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/e2b-template.mjs");

const FAKE_API_KEY = "e2b_FAKE_API_KEY_do_not_leak_123";
const FAKE_PASSWORD = "FAKE_REGISTRY_PASSWORD_do_not_leak_456";
const FAKE_USERNAME = "fake-registry-user";

function run(args, env) {
  // Start from a minimal environment so the developer's real E2B_* / registry
  // variables can never influence (or leak into) the test.
  return spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

test("dry run prints the build, login, push and template steps with secrets redacted", () => {
  const result = run(["--dry-run"], {
    E2B_API_KEY: FAKE_API_KEY,
    E2B_TEMPLATE_ID: "codevil-sandbox-test",
    CODEVIL_SANDBOX_IMAGE: "registry.example.com/acme/codevil-sandbox:1.2.3",
    CODEVIL_REGISTRY_USERNAME: FAKE_USERNAME,
    CODEVIL_REGISTRY_PASSWORD: FAKE_PASSWORD,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(
    result.stdout,
    /docker build --build-arg SANDBOX_BASE=node:22-slim -f Dockerfile\.sandbox -t registry\.example\.com\/acme\/codevil-sandbox:1\.2\.3 \./,
  );
  assert.match(result.stdout, /docker login registry\.example\.com .*--password-stdin/);
  assert.match(result.stdout, /docker push registry\.example\.com\/acme\/codevil-sandbox:1\.2\.3/);
  assert.match(result.stdout, /codevil-sandbox-test/);
  assert.match(result.stdout, /cpuCount: 2/);
  assert.match(result.stdout, /memoryMB: 4096/);

  assert.ok(!output.includes(FAKE_API_KEY), "E2B API key must not be printed");
  assert.ok(!output.includes(FAKE_PASSWORD), "registry password must not be printed");
  assert.ok(!output.includes(FAKE_USERNAME), "registry username must not be printed");
  // The password may only reach docker through stdin, never as an argument.
  assert.doesNotMatch(result.stdout, /(?:^|\s)(?:-p|--password)(?:\s|=)/m);
});

test("dry run defaults the template id and skips docker login without registry credentials", () => {
  const result = run(["--dry-run"], {
    E2B_API_KEY: FAKE_API_KEY,
    CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/codevil-sandbox:latest",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /template "codevil-sandbox"/);
  assert.doesNotMatch(result.stdout, /docker login/);
  assert.match(result.stdout, /docker push ghcr\.io\/acme\/codevil-sandbox:latest/);
  assert.ok(!result.stdout.includes(FAKE_API_KEY));
});

test("missing required variables fail with a clear message that lists them", () => {
  const result = run(["--dry-run"], {});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E2B_API_KEY/);
  assert.match(result.stderr, /CODEVIL_SANDBOX_IMAGE/);
});

test("a registry username without a password (or vice versa) is rejected without echoing secrets", () => {
  const result = run(["--dry-run"], {
    E2B_API_KEY: FAKE_API_KEY,
    CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/codevil-sandbox:latest",
    CODEVIL_REGISTRY_PASSWORD: FAKE_PASSWORD,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CODEVIL_REGISTRY_USERNAME/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_PASSWORD));
});
