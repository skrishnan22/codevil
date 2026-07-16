import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CURRENT_MARKER = "No migrations to apply!";
const PENDING_MARKER = "Migrations to be applied:";
const APPLY_COMMAND =
  "pnpm --filter @codevil/worker exec wrangler d1 migrations apply DB --remote";

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function combinedOutput(result) {
  return stripAnsi([result.stdout, result.stderr].filter(Boolean).join("\n")).trim();
}

function summary(title, output, instructions) {
  const sections = [`## ${title}`];

  if (output) {
    sections.push("```text", output, "```");
  }

  if (instructions) {
    sections.push(instructions);
  }

  return `${sections.join("\n\n")}\n`;
}

export function evaluateMigrationCheck(result, writers) {
  const output = combinedOutput(result);

  if (result.status !== 0) {
    writers.writeError("Could not check D1 migrations; deployment was blocked.");
    writers.writeSummary(
      summary(
        "D1 migration check failed",
        output,
        "Fix the Cloudflare authentication or Wrangler error, then rerun this job.",
      ),
    );
    return 1;
  }

  if (output.includes(PENDING_MARKER)) {
    writers.writeError("Pending D1 migrations blocked the deployment.");
    writers.writeSummary(
      summary(
        "Deployment blocked by pending D1 migrations",
        output,
        `Apply them manually, then rerun this job:\n\n\`${APPLY_COMMAND}\``,
      ),
    );
    return 1;
  }

  if (output.includes(CURRENT_MARKER)) {
    return 0;
  }

  writers.writeError(
    "Could not determine D1 migration state from Wrangler output; deployment was blocked.",
  );
  writers.writeSummary(
    summary(
      "D1 migration state was unrecognized",
      output,
      "Review the Wrangler output and update the migration gate before rerunning this job.",
    ),
  );
  return 1;
}

function escapeWorkflowCommand(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function githubWriters(env) {
  return {
    writeError(message) {
      console.error(`::error title=D1 migration gate::${escapeWorkflowCommand(message)}`);
    },
    writeSummary(message) {
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, message);
      } else {
        console.error(message);
      }
    },
  };
}

export function runMigrationCheck({
  env = process.env,
  spawn = spawnSync,
  writers = githubWriters(env),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
  const result = spawn(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "list", "DB", "--remote"],
    {
      cwd: workerDirectory,
      encoding: "utf8",
      env,
    },
  );

  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);

  return evaluateMigrationCheck(
    {
      status: result.error ? 1 : result.status,
      stdout: result.stdout ?? "",
      stderr: result.error?.message ?? result.stderr ?? "",
    },
    writers,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runMigrationCheck();
}
