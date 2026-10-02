#!/usr/bin/env node
// Build the shared Dockerfile.sandbox on a plain node:22-slim base, push it to a
// registry, and publish it as an E2B template.
//
// E2B's Template SDK `fromDockerfile` rejects multi-stage Dockerfiles, so the
// route is: docker build -> docker push -> Template().fromImage(<image>) ->
// Template.build(). Everything is configured through environment variables;
// secrets are never printed and the registry password reaches docker only via
// `--password-stdin`.
//
//   E2B_API_KEY                 required
//   CODEVIL_SANDBOX_IMAGE       required, full registry ref to build/push
//   E2B_TEMPLATE_ID             optional, default "codevil-sandbox"
//   CODEVIL_REGISTRY_USERNAME   optional, private registry login (with password)
//   CODEVIL_REGISTRY_PASSWORD   optional, private registry login (with username)
//
// Pass --dry-run to print the planned steps without executing anything. The
// printed plan and the executed commands come from the same step list
// (buildSteps), so they cannot drift apart.
//
// Test hook: CODEVIL_E2B_TEMPLATE_SKIP_BUILD=1 runs the docker steps for real
// but skips the final E2B Template.build call (tests put a fake `docker` first
// on PATH and have no E2B account). Never set it when publishing.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_BASE = "node:22-slim";
const DOCKERFILE = "Dockerfile.sandbox";
const DEFAULT_TEMPLATE_ID = "codevil-sandbox";
const CPU_COUNT = 2;
const MEMORY_MB = 4096;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fail(message) {
  console.error(`e2b:template: ${message}`);
  process.exit(1);
}

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Registry host of an image ref, or undefined for Docker Hub refs. */
function registryHost(image) {
  const first = image.split("/")[0];
  if (image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    return first;
  }
  return undefined;
}

/** Image refs and template ids end up in argv/API calls: no option-lookalikes or whitespace. */
function assertSafeValue(name, value) {
  if (value.startsWith("-") || /\s/.test(value)) {
    fail(`${name} must not start with "-" or contain whitespace`);
  }
}

function loadConfig() {
  const apiKey = readEnv("E2B_API_KEY");
  const image = readEnv("CODEVIL_SANDBOX_IMAGE");
  const username = readEnv("CODEVIL_REGISTRY_USERNAME");
  const password = readEnv("CODEVIL_REGISTRY_PASSWORD");
  const missing = [];
  if (!apiKey) missing.push("E2B_API_KEY");
  if (!image) missing.push("CODEVIL_SANDBOX_IMAGE (full registry image ref to build and push, e.g. ghcr.io/<owner>/codevil-sandbox:<tag>)");
  if (missing.length > 0) {
    fail(`missing required environment variable(s):\n  - ${missing.join("\n  - ")}`);
  }
  if (Boolean(username) !== Boolean(password)) {
    fail(
      `set both CODEVIL_REGISTRY_USERNAME and CODEVIL_REGISTRY_PASSWORD for a private registry, or neither (missing ${
        username ? "CODEVIL_REGISTRY_PASSWORD" : "CODEVIL_REGISTRY_USERNAME"
      })`,
    );
  }
  const templateId = readEnv("E2B_TEMPLATE_ID") ?? DEFAULT_TEMPLATE_ID;
  assertSafeValue("CODEVIL_SANDBOX_IMAGE", image);
  assertSafeValue("E2B_TEMPLATE_ID", templateId);
  return {
    apiKey,
    image,
    templateId,
    credentials: username && password ? { username, password } : undefined,
  };
}

/**
 * The single source of truth for the docker steps: each step carries the exact
 * argv that is spawned, an optional stdin payload (only the registry password),
 * and a redacted display form that is the only thing ever printed.
 */
function buildSteps(config) {
  const host = registryHost(config.image);
  const steps = [
    {
      argv: ["docker", "build", "--build-arg", `SANDBOX_BASE=${SANDBOX_BASE}`, "-f", DOCKERFILE, "-t", config.image, "."],
    },
  ];
  if (config.credentials) {
    steps.push({
      argv: ["docker", "login", ...(host ? [host] : []), "-u", config.credentials.username, "--password-stdin"],
      stdin: config.credentials.password,
      display: `docker login${host ? ` ${host}` : ""} -u "$CODEVIL_REGISTRY_USERNAME" --password-stdin  # password piped on stdin from $CODEVIL_REGISTRY_PASSWORD`,
    });
  }
  steps.push({ argv: ["docker", "push", config.image] });
  return steps;
}

const displayOf = (step) => step.display ?? step.argv.join(" ");

function templateDisplay(config) {
  return `E2B Template.build(Template().fromImage("${config.image}"${
    config.credentials ? ", { username: $CODEVIL_REGISTRY_USERNAME, password: $CODEVIL_REGISTRY_PASSWORD }" : ""
  }), template "${config.templateId}", { cpuCount: ${CPU_COUNT}, memoryMB: ${MEMORY_MB} })  # authenticated with $E2B_API_KEY`;
}

/** Docker never needs the E2B key or registry secrets in its environment. */
function dockerEnv() {
  const env = { ...process.env };
  for (const name of ["E2B_API_KEY", "CODEVIL_REGISTRY_USERNAME", "CODEVIL_REGISTRY_PASSWORD"]) delete env[name];
  return env;
}

function runStep(step) {
  const [command, ...args] = step.argv;
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: dockerEnv(),
    stdio: [step.stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    input: step.stdin,
  });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0]} failed with exit code ${result.status}`);
}

function parseArgs(argv) {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--") continue; // package-manager separator
    if (arg === "--dry-run") dryRun = true;
    else fail(`unknown argument "${arg}" (supported: --dry-run)`);
  }
  return { dryRun };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const steps = buildSteps(config);

  if (dryRun) {
    console.log("e2b:template dry run (nothing will be executed):");
    [...steps.map(displayOf), templateDisplay(config)].forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    return;
  }

  for (const step of steps) {
    console.log(`> ${displayOf(step)}`);
    runStep(step);
  }

  if (process.env.CODEVIL_E2B_TEMPLATE_SKIP_BUILD === "1") {
    console.error("E2B template NOT published: CODEVIL_E2B_TEMPLATE_SKIP_BUILD=1 is set (test-only switch)");
    return;
  }

  const { Template, defaultBuildLogger } = await import("e2b");
  console.log(`Publishing E2B template "${config.templateId}" (${CPU_COUNT} vCPU / ${MEMORY_MB} MiB)`);
  const template = Template().fromImage(config.image, config.credentials);
  await Template.build(template, config.templateId, {
    apiKey: config.apiKey,
    cpuCount: CPU_COUNT,
    memoryMB: MEMORY_MB,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(`E2B template ready: ${config.templateId}`);
}

main().catch((error) => {
  // Report the message only; never dump option/env objects that hold secrets.
  fail(error instanceof Error ? error.message : String(error));
});
