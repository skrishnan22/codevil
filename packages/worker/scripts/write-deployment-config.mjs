import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const D1_BLOCK_PATTERN = /^(\[\[d1_databases\]\]\n(?:[^\n]*\n)*?binding = "DB"\n(?:[^\n]*\n)*?database_name = "[^"]+"\n)/m;

export function buildDeploymentConfig(portableConfig, databaseId) {
  if (!D1_ID_PATTERN.test(databaseId)) {
    throw new Error("CLOUDFLARE_D1_DATABASE_ID must be a D1 database id.");
  }

  if (/^database_id\s*=/m.test(portableConfig)) {
    throw new Error("Portable Wrangler config must not include a database_id.");
  }

  if (!D1_BLOCK_PATTERN.test(portableConfig)) {
    throw new Error('Could not find the DB D1 binding in Wrangler config.');
  }

  return portableConfig.replace(
    D1_BLOCK_PATTERN,
    `$1database_id = "${databaseId}"\n`,
  );
}

export async function writeDeploymentConfig({ inputPath, outputPath, databaseId }) {
  const portableConfig = await readFile(inputPath, "utf8");
  const deploymentConfig = buildDeploymentConfig(portableConfig, databaseId);
  await writeFile(outputPath, deploymentConfig, { mode: 0o600 });
}

async function main() {
  await writeDeploymentConfig({
    inputPath: new URL("../wrangler.toml", import.meta.url),
    outputPath: new URL("../.wrangler.deploy.toml", import.meta.url),
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not generate deployment config.");
    process.exitCode = 1;
  });
}
