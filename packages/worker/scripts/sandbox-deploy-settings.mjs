import { appendFile, readFile } from "node:fs/promises";

import { sandboxDeploymentSettings, sandboxStepOutputs } from "./write-deployment-config.mjs";

// Tells the CI publish job which sandbox provider wrangler.toml selects, and
// for E2B which template to publish, through $GITHUB_OUTPUT.
try {
  const sandbox = sandboxDeploymentSettings(await readFile(new URL("../wrangler.toml", import.meta.url), "utf8"));
  const outputs = sandboxStepOutputs(sandbox);
  process.stdout.write(outputs);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, outputs);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not read sandbox deployment settings.");
  process.exitCode = 1;
}
