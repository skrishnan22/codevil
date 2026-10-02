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
// Pass --dry-run to print the planned steps without executing anything.
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
  return {
    apiKey,
    image,
    templateId: readEnv("E2B_TEMPLATE_ID") ?? DEFAULT_TEMPLATE_ID,
    credentials: username && password ? { username, password } : undefined,
  };
}

function printPlan(config) {
  const host = registryHost(config.image);
  const lines = [
    `docker build --build-arg SANDBOX_BASE=${SANDBOX_BASE} -f ${DOCKERFILE} -t ${config.image} .`,
  ];
  if (config.credentials) {
    lines.push(
      `docker login${host ? ` ${host}` : ""} -u "$CODEVIL_REGISTRY_USERNAME" --password-stdin  # password piped from $CODEVIL_REGISTRY_PASSWORD`,
    );
  }
  lines.push(`docker push ${config.image}`);
  lines.push(
    `E2B Template.build(Template().fromImage("${config.image}"${
      config.credentials ? ", { username: $CODEVIL_REGISTRY_USERNAME, password: $CODEVIL_REGISTRY_PASSWORD }" : ""
    }), template "${config.templateId}", { cpuCount: ${CPU_COUNT}, memoryMB: ${MEMORY_MB} })  # authenticated with $E2B_API_KEY`,
  );
  return lines;
}

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    stdio: ["pipe", "inherit", "inherit"],
    ...options,
  });
  if (result.error) fail(`could not run docker: ${result.error.message}`);
  if (result.status !== 0) fail(`docker ${args[0]} failed with exit code ${result.status}`);
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const config = loadConfig();

  if (dryRun) {
    console.log("e2b:template dry run (nothing will be executed):");
    printPlan(config).forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    return;
  }

  console.log(`Building ${config.image} on ${SANDBOX_BASE}`);
  docker(["build", "--build-arg", `SANDBOX_BASE=${SANDBOX_BASE}`, "-f", DOCKERFILE, "-t", config.image, "."]);

  if (config.credentials) {
    const host = registryHost(config.image);
    docker(["login", ...(host ? [host] : []), "-u", config.credentials.username, "--password-stdin"], {
      input: config.credentials.password,
    });
  }

  console.log(`Pushing ${config.image}`);
  docker(["push", config.image]);

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
