import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

test("dry run accepts a leading bare -- separator and rejects unknown arguments", () => {
  const env = { E2B_API_KEY: FAKE_API_KEY, CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/codevil-sandbox:latest" };
  const withSeparator = run(["--", "--dry-run"], env);
  assert.equal(withSeparator.status, 0, withSeparator.stderr);
  assert.match(withSeparator.stdout, /dry run/);
  const without = run(["--dry-run"], env);
  assert.equal(without.stdout, withSeparator.stdout);

  const unknown = run(["--dry-run", "--dryrun"], env);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown argument/);
  // A bare "--" alone is not a dry run: it must try to execute (docker is absent from PATH here).
  const bare = run(["--"], { ...env, PATH: "" });
  assert.notEqual(bare.status, 0);
  assert.doesNotMatch(bare.stdout, /dry run/);
});

for (const [name, env, pattern] of [
  ["image starting with a dash", { CODEVIL_SANDBOX_IMAGE: "--privileged" }, /CODEVIL_SANDBOX_IMAGE/],
  ["image containing whitespace", { CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/x:1 --pull" }, /CODEVIL_SANDBOX_IMAGE/],
  ["template id starting with a dash", { E2B_TEMPLATE_ID: "-bad" }, /E2B_TEMPLATE_ID/],
  ["template id containing whitespace", { E2B_TEMPLATE_ID: "my template" }, /E2B_TEMPLATE_ID/],
]) {
  test(`rejects ${name}`, () => {
    const result = run(["--dry-run"], {
      E2B_API_KEY: FAKE_API_KEY,
      CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/codevil-sandbox:latest",
      ...env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /must not start with "-" or contain whitespace/);
    assert.doesNotMatch(result.stdout, /dry run/);
  });
}

/**
 * Runs the script for real (no --dry-run) against a fake `docker` first on PATH.
 * The shim records argv, stdin and the names of the environment variables it was
 * given, then exits with `shimExit`. The final E2B Template.build call is skipped
 * through the script's test-only CODEVIL_E2B_TEMPLATE_SKIP_BUILD=1 switch.
 */
function runWithDockerShim(env, { shimExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e2b-template-shim-"));
  try {
    const log = join(dir, "calls.jsonl");
    const shim = join(dir, "docker");
    writeFileSync(
      shim,
      `#!${process.execPath}
const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, envKeys: Object.keys(process.env) }) + "\\n");
process.exit(${shimExit});
`,
    );
    chmodSync(shim, 0o755);
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, SHIM_LOG: log, CODEVIL_E2B_TEMPLATE_SKIP_BUILD: "1", ...env },
      encoding: "utf8",
    });
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      // no docker call was made
    }
    return { result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real run executes build, login, push through docker with the password only on login stdin", () => {
  const { result, calls } = runWithDockerShim({
    E2B_API_KEY: FAKE_API_KEY,
    CODEVIL_SANDBOX_IMAGE: "registry.example.com/acme/codevil-sandbox:1.2.3",
    CODEVIL_REGISTRY_USERNAME: FAKE_USERNAME,
    CODEVIL_REGISTRY_PASSWORD: FAKE_PASSWORD,
  });
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(
    calls.map((call) => call.argv),
    [
      ["build", "--build-arg", "SANDBOX_BASE=node:22-slim", "-f", "Dockerfile.sandbox", "-t", "registry.example.com/acme/codevil-sandbox:1.2.3", "."],
      ["login", "registry.example.com", "-u", FAKE_USERNAME, "--password-stdin"],
      ["push", "registry.example.com/acme/codevil-sandbox:1.2.3"],
    ],
  );

  // The password reaches docker on login's stdin and nowhere else.
  for (const call of calls) {
    assert.ok(!call.argv.some((arg) => arg.includes(FAKE_PASSWORD)), "password must never be in argv");
    assert.ok(!call.argv.some((arg) => arg === "-p" || arg === "--password"));
  }
  assert.deepEqual(calls.map((call) => call.stdin), ["", FAKE_PASSWORD, ""]);

  // Docker children get a scrubbed environment.
  for (const call of calls) {
    for (const secret of ["E2B_API_KEY", "CODEVIL_REGISTRY_PASSWORD", "CODEVIL_REGISTRY_USERNAME"]) {
      assert.ok(!call.envKeys.includes(secret), `${secret} must not be passed to docker`);
    }
  }

  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of [FAKE_API_KEY, FAKE_PASSWORD, FAKE_USERNAME]) {
    assert.ok(!output.includes(secret), "no secret may appear in output");
  }
});

test("real run without registry credentials skips docker login", () => {
  const { result, calls } = runWithDockerShim({
    E2B_API_KEY: FAKE_API_KEY,
    CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/codevil-sandbox:latest",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map((call) => call.argv[0]), ["build", "push"]);
});

test("real run stops and exits non-zero when a docker step fails", () => {
  const { result, calls } = runWithDockerShim(
    { E2B_API_KEY: FAKE_API_KEY, CODEVIL_SANDBOX_IMAGE: "ghcr.io/acme/codevil-sandbox:latest" },
    { shimExit: 3 },
  );
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 1);
  assert.match(result.stderr, /docker build failed with exit code 3/);
});
