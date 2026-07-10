import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

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

test("operator config and local variables are templates, not deployment credentials", async () => {
  const [ignore, operatorTemplate, varsTemplate] = await Promise.all([
    readFile(resolve(repoRoot, ".gitignore"), "utf8"),
    readFile(resolve(workerRoot, "wrangler.operator.example.toml"), "utf8"),
    readFile(resolve(workerRoot, ".dev.vars.example"), "utf8"),
  ]);

  assert.match(ignore, /^wrangler\.operator\.toml$/m);
  assert.match(operatorTemplate, /database_id = "your-d1-database-id"/);
  assert.match(varsTemplate, /^CODEVIL_PROXY_SIGNING_SECRET=$/m);
  for (const name of ["CODEVIL_API_KEY", "CODEVIL_SETUP_TOKEN", "CODEVIL_PROXY_SIGNING_SECRET", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_SECRET", "GITHUB_PAT"]) {
    assert.match(varsTemplate, new RegExp(`^${name}=$`, "m"));
  }
});
