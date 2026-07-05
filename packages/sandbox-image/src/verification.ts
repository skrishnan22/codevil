import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { CostInfo } from "@codevil/shared";
import { MAX_VERIFICATION_ATTEMPTS, addCost, zeroCost } from "@codevil/shared";

import { repairPrompt } from "./prompts.js";
import { detectPackageManager } from "./package-manager.js";
import { trimOutput } from "./runtime-helpers.js";

export interface VerificationResult {
  success: boolean;
  command: string;
  output: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, options: {
    cwd: string;
    timeoutMs: number;
    onOutput?: (chunk: string) => void;
    env?: Record<string, string>;
  }): Promise<CommandResult>;
}

export interface Verifier {
  verify(cwd: string): Promise<VerificationResult>;
}

export interface AgentExecutor {
  execute(plan: string): Promise<CostInfo>;
}

export interface VerificationEvents {
  verification_started(attempt: number, max_attempts: number): void;
  verification_retrying(attempt: number, max_attempts: number, last_error: string): void;
  status(message: string): void;
}

export async function runVerificationLoop(input: {
  repoDir: string;
  verifier: Verifier;
  agent: AgentExecutor;
  events: VerificationEvents;
  maxAttempts?: number;
}): Promise<{
  success: boolean;
  attempts: number;
  lastError: string;
  cost: CostInfo;
}> {
  const maxAttempts = input.maxAttempts ?? MAX_VERIFICATION_ATTEMPTS;
  let lastError = "";
  let repairCost = zeroCost();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    input.events.verification_started(attempt, maxAttempts);
    const result = await input.verifier.verify(input.repoDir);
    if (result.success) {
      input.events.status(`Verification passed on attempt ${attempt}/${maxAttempts}.`);
      return { success: true, attempts: attempt, lastError: "", cost: repairCost };
    }

    lastError = formatVerificationFailure(result);
    if (attempt === maxAttempts) {
      return { success: false, attempts: attempt, lastError, cost: repairCost };
    }

    input.events.verification_retrying(attempt, maxAttempts, lastError);
    repairCost = addCost(repairCost, await input.agent.execute(repairPrompt(attempt, maxAttempts, lastError)));
  }

  return { success: false, attempts: maxAttempts, lastError, cost: repairCost };
}

export class RepositoryVerifier implements Verifier {
  constructor(private readonly commandRunner: CommandRunner = new ShellCommandRunner()) {}

  async verify(cwd: string): Promise<VerificationResult> {
    const command = detectVerificationCommand(cwd);
    if (!command) {
      return {
        success: true,
        command: "no verification command",
        output: "No package.json or known verification command found.",
      };
    }

    const result = await this.commandRunner.run(command, {
      cwd,
      timeoutMs: 300_000,
    });
    return {
      success: result.code === 0,
      command,
      output: trimOutput(`${result.stdout}${result.stderr}`),
    };
  }
}

export class ShellCommandRunner implements CommandRunner {
  run(command: string, options: {
    cwd: string;
    timeoutMs: number;
    onOutput?: (chunk: string) => void;
    env?: Record<string, string>;
  }): Promise<CommandResult> {
    return runShell(command, options.cwd, options.timeoutMs, options.onOutput, options.env);
  }
}

export function detectSetupCommand(cwd: string): string | undefined {
  if (existsSync(join(cwd, ".codevil", "setup.sh"))) {
    return "bash .codevil/setup.sh";
  }

  const packageManager = detectPackageManager({ cwd });
  switch (packageManager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "npm":
      return "npm install --no-audit --no-fund --prefer-offline";
    case "yarn":
      return "yarn install --immutable";
    case "bun":
      return "bun install --frozen-lockfile";
    default:
      return undefined;
  }
}

export function detectVerificationCommand(cwd: string): string | undefined {
  if (existsSync(join(cwd, ".codevil", "verify.sh"))) {
    return "bash .codevil/verify.sh";
  }

  const packageJson = join(cwd, "package.json");
  if (existsSync(packageJson)) {
    const scripts = readPackageScripts(packageJson);
    if (scripts.has("test")) {
      switch (detectPackageManager({ cwd })) {
        case "pnpm":
          return "pnpm test";
        case "yarn":
          return "yarn test";
        case "bun":
          return "bun test";
        case "npm":
        default:
          return "npm test";
      }
    }
  }

  const makefile = join(cwd, "Makefile");
  if (existsSync(makefile)) {
    return "make test";
  }

  return undefined;
}

export function formatVerificationFailure(result: VerificationResult): string {
  return `${result.command} failed:\n${result.output}`.trim();
}

function readPackageScripts(packageJson: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return new Set();
    return new Set(Object.keys(parsed.scripts));
  } catch {
    return new Set();
  }
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
  env?: Record<string, string>,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      detached,
      env: env ? { ...process.env, ...env } : process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onOutput?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      onOutput?.(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out after ${timeoutMs}ms.` : stderr,
      });
    });
  });
}
