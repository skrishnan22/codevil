import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const D1_BLOCK_PATTERN = /^(\[\[d1_databases\]\]\n(?:[^\n]*\n)*?binding = "DB"\n(?:[^\n]*\n)*?database_name = "[^"]+"\n)/m;
const WEB_ORIGIN_PATTERN = /^CODEVIL_WEB_ORIGIN = "[^"]*"$/m;
const TOP_LEVEL_VARS_PATTERN = /^\[vars\]\n(?:(?![ \t]*\[)[^\n]*\n?)*/m;
const SANDBOX_PROVIDER_PATTERN = /^SANDBOX_PROVIDER = "([^"\n]*)"$/m;
const E2B_TEMPLATE_ID_PATTERN = /^E2B_TEMPLATE_ID = "([A-Za-z0-9][A-Za-z0-9._/-]*)"$/m;
const E2B_TEMPLATE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The top-level [vars] table only; [env.*.vars] must not decide production. */
function topLevelVars(portableConfig) {
  return portableConfig.match(TOP_LEVEL_VARS_PATTERN)?.[0] ?? "";
}

/**
 * Sandbox settings the deploy pipeline acts on. The provider must be explicit:
 * with no SANDBOX_PROVIDER the Worker would silently default to E2B.
 */
export function sandboxDeploymentSettings(portableConfig) {
  const vars = topLevelVars(portableConfig);
  const provider = vars.match(SANDBOX_PROVIDER_PATTERN)?.[1];
  if (provider === "cloudflare") return { provider };
  if (provider !== "e2b") {
    throw new Error('Portable Wrangler config [vars] must contain the line SANDBOX_PROVIDER = "e2b" or SANDBOX_PROVIDER = "cloudflare".');
  }
  const templateId = vars.match(E2B_TEMPLATE_ID_PATTERN)?.[1];
  if (!templateId) {
    throw new Error('Portable Wrangler config [vars] must contain the line E2B_TEMPLATE_ID = "<template>" (no tag) when SANDBOX_PROVIDER is e2b.');
  }
  return { provider, templateId };
}

/** `key=value` lines for $GITHUB_OUTPUT so the publish job knows whether and what to publish. */
export function sandboxStepOutputs(sandbox) {
  return [
    `sandbox_provider=${sandbox.provider}`,
    ...(sandbox.templateId ? [`e2b_template_id=${sandbox.templateId}`] : []),
  ].join("\n") + "\n";
}

export function buildDeploymentConfig(portableConfig, databaseId, webOrigin, e2bTemplateTag) {
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

  const sandbox = sandboxDeploymentSettings(portableConfig);
  let config = portableConfig;
  if (sandbox.provider === "e2b" && e2bTemplateTag !== undefined) {
    if (!E2B_TEMPLATE_TAG_PATTERN.test(e2bTemplateTag)) {
      throw new Error("E2B_TEMPLATE_TAG may contain only letters, digits, \".\", \"_\" and \"-\".");
    }
    // Pin the Worker to the template build published from this same commit.
    const vars = topLevelVars(config);
    const pinned = vars.replace(E2B_TEMPLATE_ID_PATTERN, `E2B_TEMPLATE_ID = "${sandbox.templateId}:${e2bTemplateTag}"`);
    // A function replacer, so "$" in other [vars] values is copied literally.
    config = config.replace(vars, () => pinned);
  }

  return config.replace(
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

export async function writeDeploymentConfig({ inputPath, outputPath, databaseId, webOrigin, e2bTemplateTag }) {
  const portableConfig = await readFile(inputPath, "utf8");
  const deploymentConfig = buildDeploymentConfig(portableConfig, databaseId, webOrigin, e2bTemplateTag);
  await writeFile(outputPath, deploymentConfig, { mode: 0o600 });
}

async function main() {
  await writeDeploymentConfig({
    inputPath: new URL("../wrangler.toml", import.meta.url),
    outputPath: new URL("../.wrangler.deploy.toml", import.meta.url),
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
    webOrigin: process.env.CODEVIL_WEB_ORIGIN,
    e2bTemplateTag: process.env.E2B_TEMPLATE_TAG?.trim() || undefined,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not generate deployment config.");
    process.exitCode = 1;
  });
}
