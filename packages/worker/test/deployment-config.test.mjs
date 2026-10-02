import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  buildDeploymentConfig,
  sandboxDeploymentSettings,
  sandboxStepOutputs,
} from "../scripts/write-deployment-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, "..");
const repoRoot = resolve(workerRoot, "..", "..");

test("checked-in Worker config is portable and defaults to workers.dev", async () => {
  const config = await readFile(resolve(workerRoot, "wrangler.toml"), "utf8");

  assert.match(config, /^workers_dev = true$/m);
  assert.doesNotMatch(config, /^account_id\s*=/m);
  assert.doesNotMatch(config, /^database_id\s*=/m);
  assert.doesNotMatch(config, /^\[\[routes\]\]/m);
  assert.doesNotMatch(config, /lexmora\.app|pages\.dev/);
  assert.match(config, /binding = "DB"/);
  assert.match(config, /binding = "BACKUP_BUCKET"/);
});

test("checked-in Worker config keeps production on the Cloudflare sandbox until E2B is ready", async () => {
  const [config, envExample] = await Promise.all([
    readFile(resolve(workerRoot, "wrangler.toml"), "utf8"),
    readFile(resolve(workerRoot, ".env.example"), "utf8"),
  ]);
  assert.match(config, /^SANDBOX_PROVIDER = "cloudflare"$/m);
  // The deploy pipeline must read the same answer, or every deploy fails.
  assert.deepEqual(sandboxDeploymentSettings(config), { provider: "cloudflare" });
  assert.deepEqual(
    sandboxDeploymentSettings(config.replace(/^SANDBOX_PROVIDER = "cloudflare"$/m, 'SANDBOX_PROVIDER = "e2b"')),
    { provider: "e2b", templateId: "codevil-sandbox" },
  );
  assert.doesNotMatch(config, /^E2B_API_KEY\s*=/m);
  assert.match(envExample, /^E2B_API_KEY=/m);
});

test("CI builds and smoke-tests both the Cloudflare and the E2B sandbox image variants", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /docker build -f Dockerfile\.sandbox -t codevil-sandbox:ci \./);
  assert.match(workflow, /--build-arg SANDBOX_BASE=node:22-slim -t codevil-sandbox-e2b:ci/);
  assert.match(workflow, /CODEVIL_SANDBOX_IMAGE: codevil-sandbox-e2b:ci/);
  assert.equal(workflow.match(/sandbox-image-smoke\.mjs/g)?.length, 2);
});

test("operator config and local variables are templates, not deployment credentials", async () => {
  const [ignore, operatorTemplate, varsTemplate] = await Promise.all([
    readFile(resolve(repoRoot, ".gitignore"), "utf8"),
    readFile(resolve(workerRoot, "wrangler.operator.example.toml"), "utf8"),
    readFile(resolve(workerRoot, ".dev.vars.example"), "utf8"),
  ]);

  assert.match(ignore, /^wrangler\.operator\.toml$/m);
  assert.match(operatorTemplate, /database_id = "your-d1-database-id"/);
  assert.match(operatorTemplate, /^SANDBOX_PROVIDER = "cloudflare"$/m);
  assert.match(varsTemplate, /^CODEVIL_PROXY_SIGNING_SECRET=$/m);
  for (const name of ["CODEVIL_API_KEY", "CODEVIL_SETUP_TOKEN", "CODEVIL_PROXY_SIGNING_SECRET", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_SECRET", "GITHUB_PAT"]) {
    assert.match(varsTemplate, new RegExp(`^${name}=$`, "m"));
  }
});

test("deployment overlay adds a validated D1 id and explicit web origin", () => {
  const portable = [
    'name = "codevil"',
    "",
    "[vars]",
    'SANDBOX_PROVIDER = "cloudflare"',
    'CODEVIL_WEB_ORIGIN = "http://localhost:5173,http://localhost:8787"',
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "codevil"',
    'migrations_dir = "migrations"',
  ].join("\n");

  const overlay = buildDeploymentConfig(
    portable,
    "11111111-2222-4333-8444-555555555555",
    "https://codevil-ui.pages.dev",
  );

  assert.match(overlay, /database_id = "11111111-2222-4333-8444-555555555555"/);
  assert.match(overlay, /^CODEVIL_WEB_ORIGIN = "https:\/\/codevil-ui\.pages\.dev"$/m);
  assert.equal((overlay.match(/^database_id\s*=/gm) ?? []).length, 1);
  assert.doesNotMatch(overlay, /account_id\s*=/);
});

test("deployment overlay requires a valid production web origin", () => {
  const portable = [
    "[vars]",
    'SANDBOX_PROVIDER = "cloudflare"',
    'CODEVIL_WEB_ORIGIN = "http://localhost:5173,http://localhost:8787"',
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "codevil"',
    'migrations_dir = "migrations"',
  ].join("\n");

  assert.throws(
    () => buildDeploymentConfig(portable, "11111111-2222-4333-8444-555555555555", "not a URL"),
    /CODEVIL_WEB_ORIGIN/i,
  );
});

const E2B_PORTABLE = [
  "[vars]",
  'SANDBOX_PROVIDER = "e2b"',
  'E2B_TEMPLATE_ID = "codevil-sandbox"',
  'CODEVIL_WEB_ORIGIN = "http://localhost:5173"',
  "",
  "[[d1_databases]]",
  'binding = "DB"',
  'database_name = "codevil"',
  'migrations_dir = "migrations"',
].join("\n");
const D1_ID = "11111111-2222-4333-8444-555555555555";
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("deployment overlay pins an E2B Worker to the template build tagged with this commit", () => {
  const overlay = buildDeploymentConfig(E2B_PORTABLE, D1_ID, "https://codevil.example", SHA);

  assert.match(overlay, new RegExp(`^E2B_TEMPLATE_ID = "codevil-sandbox:${SHA}"$`, "m"));
  assert.equal((overlay.match(/^E2B_TEMPLATE_ID/gm) ?? []).length, 1);
});

test("deployment overlay copies other [vars] values literally when pinning", () => {
  const portable = E2B_PORTABLE.replace("[vars]", () => '[vars]\nGREETING = "costs $$5, $& and $`"');
  const overlay = buildDeploymentConfig(portable, D1_ID, "https://codevil.example", SHA);

  assert.match(overlay, /^GREETING = "costs \$\$5, \$& and \$`"$/m);
  assert.equal((overlay.match(/^\[vars\]$/gm) ?? []).length, 1);
});

test("deployment overlay leaves E2B_TEMPLATE_ID alone without a tag or on Cloudflare", () => {
  const untagged = buildDeploymentConfig(E2B_PORTABLE, D1_ID, "https://codevil.example");
  assert.match(untagged, /^E2B_TEMPLATE_ID = "codevil-sandbox"$/m);

  const cloudflare = buildDeploymentConfig(
    E2B_PORTABLE.replace('SANDBOX_PROVIDER = "e2b"', 'SANDBOX_PROVIDER = "cloudflare"'),
    D1_ID,
    "https://codevil.example",
    SHA,
  );
  assert.match(cloudflare, /^E2B_TEMPLATE_ID = "codevil-sandbox"$/m);
});

test("deployment overlay rejects an unsafe E2B template tag", () => {
  for (const tag of ["", "-x", "a:b", 'a"b', "a b"]) {
    assert.throws(
      () => buildDeploymentConfig(E2B_PORTABLE, D1_ID, "https://codevil.example", tag),
      /E2B_TEMPLATE_TAG/,
    );
  }
});

test("sandbox deployment settings require an explicit provider and an untagged E2B template id", () => {
  const vars = (...lines) => ["[vars]", ...lines].join("\n");
  assert.deepEqual(sandboxDeploymentSettings(vars('SANDBOX_PROVIDER = "cloudflare"')), { provider: "cloudflare" });
  assert.deepEqual(sandboxDeploymentSettings(E2B_PORTABLE), { provider: "e2b", templateId: "codevil-sandbox" });

  // No provider would make the Worker default to E2B silently.
  assert.throws(() => sandboxDeploymentSettings(vars('E2B_TEMPLATE_ID = "codevil-sandbox"')), /SANDBOX_PROVIDER/);
  assert.throws(() => sandboxDeploymentSettings(vars('SANDBOX_PROVIDER = "daytona"')), /SANDBOX_PROVIDER/);
  assert.throws(() => sandboxDeploymentSettings('SANDBOX_PROVIDER = "e2b"'), /SANDBOX_PROVIDER/);
  assert.throws(() => sandboxDeploymentSettings(vars('SANDBOX_PROVIDER = "e2b"')), /E2B_TEMPLATE_ID/);
  for (const templateId of ["codevil-sandbox:v1", "-x", "a\nb=c"]) {
    assert.throws(
      () => sandboxDeploymentSettings(vars('SANDBOX_PROVIDER = "e2b"', `E2B_TEMPLATE_ID = "${templateId}"`)),
      /E2B_TEMPLATE_ID/,
    );
  }
});

test("sandbox deployment settings read only the top-level [vars] table", () => {
  const config = [
    "[env.staging.vars]",
    'SANDBOX_PROVIDER = "e2b"',
    'E2B_TEMPLATE_ID = "staging-sandbox"',
    "",
    "[vars]",
    'SANDBOX_PROVIDER = "cloudflare"',
    'E2B_TEMPLATE_ID = "codevil-sandbox"',
    "",
    "  [containers.ssh]",
    'SANDBOX_PROVIDER = "e2b"',
  ].join("\n");
  assert.deepEqual(sandboxDeploymentSettings(config), { provider: "cloudflare" });

  const e2b = [
    "[env.staging.vars]",
    'E2B_TEMPLATE_ID = "staging-sandbox"',
    "",
    "[vars]",
    'SANDBOX_PROVIDER = "e2b"',
    'E2B_TEMPLATE_ID = "codevil-sandbox"',
    'CODEVIL_WEB_ORIGIN = "http://localhost:5173"',
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "codevil"',
    "",
  ].join("\n");
  const overlay = buildDeploymentConfig(e2b, D1_ID, "https://codevil.example", SHA);
  assert.match(overlay, /^E2B_TEMPLATE_ID = "staging-sandbox"$/m);
  assert.match(overlay, new RegExp(`^E2B_TEMPLATE_ID = "codevil-sandbox:${SHA}"$`, "m"));
});

test("sandbox step outputs tell CI whether and what to publish", () => {
  assert.equal(sandboxStepOutputs({ provider: "cloudflare" }), "sandbox_provider=cloudflare\n");
  assert.equal(
    sandboxStepOutputs({ provider: "e2b", templateId: "codevil-sandbox" }),
    "sandbox_provider=e2b\ne2b_template_id=codevil-sandbox\n",
  );
});

test("deployment overlay rejects an unsafe D1 id", () => {
  assert.throws(
    () => buildDeploymentConfig('[[d1_databases]]\nbinding = "DB"', '"bad"'),
    /D1 database id/i,
  );
});

test("production CI generates and uses a D1 deployment overlay", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /CLOUDFLARE_D1_DATABASE_ID: \$\{\{ secrets\.CLOUDFLARE_D1_DATABASE_ID \}\}/);
  assert.match(workflow, /CODEVIL_WEB_ORIGIN: \$\{\{ vars\.CODEVIL_WEB_ORIGIN \}\}/);
  assert.match(workflow, /write-deployment-config\.mjs/);
  assert.match(workflow, /CODEVIL_WRANGLER_CONFIG: \.wrangler\.deploy\.toml/);
  assert.match(workflow, /wrangler deploy --config \.wrangler\.deploy\.toml/);
  assert.match(
    workflow,
    /pnpm --filter @codevil\/shared run build\s+pnpm --filter @codevil\/web run build/,
  );
});

test("sandbox-deploy-settings writes the provider outputs for the CI publish job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-deploy-settings-"));
  try {
    const outputFile = join(dir, "github-output");
    const result = spawnSync(process.execPath, [resolve(workerRoot, "scripts/sandbox-deploy-settings.mjs")], {
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: outputFile },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(outputFile, "utf8"), "sandbox_provider=cloudflare\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function workflowJob(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test("production CI publishes this commit's E2B template in its own job before the Worker deploy", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const publish = workflowJob(workflow, "e2b-template");
  const deploy = workflowJob(workflow, "deploy");

  assert.match(publish, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /permissions:\n\s+contents: read\n\s+packages: write/);
  assert.match(publish, /id: sandbox\n\s+run: pnpm --filter @codevil\/worker exec node scripts\/sandbox-deploy-settings\.mjs/);
  assert.match(publish, /if: steps\.sandbox\.outputs\.sandbox_provider == 'e2b'/);
  assert.match(publish, /pnpm --filter @codevil\/sandbox-image e2b:template/);
  assert.match(publish, /CODEVIL_SANDBOX_IMAGE="ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/codevil-sandbox:\$\{GITHUB_SHA\}"/);
  assert.match(publish, /E2B_API_KEY: \$\{\{ secrets\.E2B_API_KEY \}\}/);
  assert.match(publish, /E2B_TEMPLATE_ID: \$\{\{ steps\.sandbox\.outputs\.e2b_template_id \}\}/);
  assert.match(publish, /E2B_TEMPLATE_TAG: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /CODEVIL_REGISTRY_PASSWORD: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(publish, /CLOUDFLARE_API_TOKEN/);

  // The Worker is deployed only after the publish job succeeds, pinned to the same SHA,
  // and the job holding Cloudflare credentials cannot write packages.
  assert.match(deploy, /needs:\n(?:\s+- [a-z-]+\n)*\s+- e2b-template\n/);
  assert.match(deploy, /write-deployment-config\.mjs\n\s+env:\n\s+E2B_TEMPLATE_TAG: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(deploy, /packages: write|e2b:template|GITHUB_TOKEN/);
});
