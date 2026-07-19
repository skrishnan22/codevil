import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const D1_BLOCK_PATTERN = /^(\[\[d1_databases\]\]\n(?:[^\n]*\n)*?binding = "DB"\n(?:[^\n]*\n)*?database_name = "[^"]+"\n)/m;
const WEB_ORIGIN_PATTERN = /^CODEVIL_WEB_ORIGIN = "[^"]*"$/m;

export function buildDeploymentConfig(portableConfig, databaseId, webOrigin) {
  if (!D1_ID_PATTERN.test(databaseId)) {
    throw new Error("CLOUDFLARE_D1_DATABASE_ID must be a D1 database id.");
  }

  const normalizedWebOrigin = normalizeWebOrigins(webOrigin);

  if (/^database_id\s*=/m.test(portableConfig)) {
    throw new Error("Portable Wrangler config must not include a database_id.");
  }

  if (!WEB_ORIGIN_PATTERN.test(portableConfig)) {
    throw new Error("Portable Wrangler config must include CODEVIL_WEB_ORIGIN.");
  }

  if (!D1_BLOCK_PATTERN.test(portableConfig)) {
    throw new Error('Could not find the DB D1 binding in Wrangler config.');
  }

  return portableConfig.replace(
    WEB_ORIGIN_PATTERN,
    `CODEVIL_WEB_ORIGIN = "${normalizedWebOrigin}"`,
  ).replace(
    D1_BLOCK_PATTERN,
    `$1database_id = "${databaseId}"\n`,
  );
}

function normalizeWebOrigins(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("CODEVIL_WEB_ORIGIN must contain at least one HTTPS web origin.");
  }

  const origins = value.split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);
  if (origins.length === 0) {
    throw new Error("CODEVIL_WEB_ORIGIN must contain at least one HTTPS web origin.");
  }

  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("CODEVIL_WEB_ORIGIN must contain only absolute HTTPS web origins.");
    }
    if (url.protocol !== "https:" || url.origin !== origin) {
      throw new Error("CODEVIL_WEB_ORIGIN must contain only absolute HTTPS web origins.");
    }
  }

  return origins.join(",");
}

export async function writeDeploymentConfig({ inputPath, outputPath, databaseId, webOrigin }) {
  const portableConfig = await readFile(inputPath, "utf8");
  const deploymentConfig = buildDeploymentConfig(portableConfig, databaseId, webOrigin);
  await writeFile(outputPath, deploymentConfig, { mode: 0o600 });
}

async function main() {
  await writeDeploymentConfig({
    inputPath: new URL("../wrangler.toml", import.meta.url),
    outputPath: new URL("../.wrangler.deploy.toml", import.meta.url),
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
    webOrigin: process.env.CODEVIL_WEB_ORIGIN,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not generate deployment config.");
    process.exitCode = 1;
  });
}
