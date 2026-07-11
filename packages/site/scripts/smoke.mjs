import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve("dist");
const htmlPath = resolve(dist, "index.html");

const errors = [];

if (!existsSync(htmlPath)) {
  console.error(`[smoke] FAIL: ${htmlPath} does not exist. Run \`pnpm build\` first.`);
  process.exit(1);
}

const html = await readFile(htmlPath, "utf8");

const expectations = [
  "Bring your team into the session",
  "Deploy on Cloudflare",
  "Open the app",
  "Multiplayer sessions",
  "Collaborative plan annotation",
  "Ask the session",
  "Live preview",
  "Projected conversation",
  "wrangler deploy",
  "wrangler secret put CODEVIL_API_KEY",
  "wrangler secret put BETTER_AUTH_SECRET",
  "Is Codevil a CLI or a web app?",
  "Does the agent always plan before executing?",
];

for (const needle of expectations) {
  if (!html.includes(needle)) {
    errors.push(`missing expected string: "${needle}"`);
  }
}

const hasIsland = html.includes("astro-island") || html.includes("DeployCommands");
if (!hasIsland) {
  errors.push("React island (DeployCommands) not hydrated in output");
}

if (errors.length > 0) {
  console.error("[smoke] FAIL:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[smoke] OK: ${expectations.length} strings present, island hydrated.`);
