import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

import type {
  CostInfo,
  DOToSandboxMessage,
  SandboxToDOMessage,
} from "@codevil/shared";
import { MAX_VERIFICATION_ATTEMPTS } from "@codevil/shared";

export interface AgentStartOptions {
  cwd: string;
  mode: "read-only";
  model: string;
  provider: string;
  llmKey?: string;
  onEvent(event: unknown): void;
}

export interface PlanResult {
  plan: string;
  cost: CostInfo;
}

export interface AgentDriver {
  start(options: AgentStartOptions): Promise<void>;
  plan(prompt: string): Promise<PlanResult>;
  refine(feedback: string): Promise<PlanResult>;
  switchToExecution(model: string, provider?: string): Promise<void>;
  execute(plan: string): Promise<CostInfo>;
  dispose?(): Promise<void> | void;
}

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
  }): Promise<CommandResult>;
}

export interface Verifier {
  verify(cwd: string): Promise<VerificationResult>;
}

export interface AgentDriverFactory {
  (): AgentDriver;
}

export interface GitDriver {
  clone(repo: string, destination: string, onProgress: (line: string) => void, credential?: GitCredential): Promise<void>;
  defaultBranch(cwd: string): Promise<string>;
  pushBranch(options: PushBranchOptions): Promise<void>;
}

export interface GitCredential {
  username: string;
  password: string;
}

export interface PushBranchOptions {
  cwd: string;
  branch: string;
  commitMessage: string;
  credential?: GitCredential;
}

export interface SandboxRuntimeOptions {
  workspace: string;
  provider?: string;
  llmKey?: string;
  send(message: SandboxToDOMessage): void;
  agentFactory: AgentDriverFactory;
  git: GitDriver;
  verifier?: Verifier;
  commandRunner?: CommandRunner;
  credentialTimeoutMs?: number;
}

export class SandboxRuntime {
  private readonly workspace: string;
  private readonly provider: string;
  private readonly llmKey: string | undefined;
  private readonly send: (message: SandboxToDOMessage) => void;
  private readonly agentFactory: AgentDriverFactory;
  private readonly git: GitDriver;
  private readonly verifier: Verifier;
  private readonly commandRunner: CommandRunner;
  private readonly credentialTimeoutMs: number;
  private repoDir: string | undefined;
  private repoUrl: string | undefined;
  private defaultBranchName: string | undefined;
  private agent: AgentDriver | undefined;
  private credentialRequests = new Map<string, {
    resolve(credential: GitCredential | undefined): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: SandboxRuntimeOptions) {
    this.workspace = options.workspace;
    this.provider = options.provider ?? "anthropic";
    this.llmKey = options.llmKey;
    this.send = options.send;
    this.agentFactory = options.agentFactory;
    this.git = options.git;
    this.commandRunner = options.commandRunner ?? new ShellCommandRunner();
    this.verifier = options.verifier ?? new RepositoryVerifier(this.commandRunner);
    this.credentialTimeoutMs = options.credentialTimeoutMs ?? 10_000;
  }

  async handleMessage(message: DOToSandboxMessage): Promise<void> {
    try {
      switch (message.type) {
        case "init":
          await this.handleInit(message.repo);
          return;
        case "plan":
          await this.handlePlan(message.prompt, message.model, message.provider);
          return;
        case "refine_plan":
          await this.handleRefine(message.feedback);
          return;
        case "execute":
          await this.handleExecute(message.plan, message.model, message.provider);
          return;
        case "create_pr":
          await this.handleCreatePullRequest(message);
          return;
        case "credential_response":
          this.handleCredentialResponse(message);
          return;
      }
    } catch (error) {
      this.send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async dispose(): Promise<void> {
    await this.agent?.dispose?.();
  }

  private async handleInit(repo: string): Promise<void> {
    const repoDir = join(this.workspace, "repo");
    this.repoDir = repoDir;
    this.repoUrl = repo;

    this.send({ type: "clone_started" });
    const credential = await this.requestCredential(repo);
    await this.git.clone(repo, repoDir, (line) => {
      this.send({ type: "clone_progress", line });
    }, credential);

    await this.setupRepository(repoDir);

    this.defaultBranchName = await this.git.defaultBranch(repoDir);
    this.send({ type: "clone_complete" });
    this.send({
      type: "status",
      message: `Repository ready on ${this.defaultBranchName}.`,
    });
  }

  private async setupRepository(repoDir: string): Promise<void> {
    const command = detectSetupCommand(repoDir);
    if (!command) return;

    this.send({ type: "status", message: `Running setup command: ${command}` });
    const result = await this.commandRunner.run(command, {
      cwd: repoDir,
      timeoutMs: 300_000,
      onOutput: (chunk) => {
        for (const line of outputLines(chunk)) {
          this.send({ type: "status", message: `Setup output: ${line}` });
        }
      },
    });

    if (result.code !== 0) {
      throw new Error(formatCommandFailure("Setup", command, result));
    }

    this.send({ type: "status", message: "Setup completed." });
  }

  private async handlePlan(
    prompt: string,
    model: string,
    provider: string | undefined,
  ): Promise<void> {
    const repoDir = this.requireRepo();
    const agent = this.agentFactory();
    this.agent = agent;

    await agent.start({
      cwd: repoDir,
      mode: "read-only",
      model,
      provider: provider ?? this.provider,
      llmKey: this.llmKey,
      onEvent: (event) => this.send({ type: "agent_event", event }),
    });

    const result = await agent.plan(planPrompt(prompt));
    this.send({ type: "plan_ready", ...result });
  }

  private async handleRefine(feedback: string): Promise<void> {
    const agent = this.requireAgent();
    const result = await agent.refine(refinePrompt(feedback));
    this.send({ type: "plan_ready", ...result });
  }

  private async handleExecute(
    plan: string,
    model: string,
    provider: string | undefined,
  ): Promise<void> {
    const agent = this.requireAgent();
    await agent.switchToExecution(model, provider ?? this.provider);
    let cost = await agent.execute(executePrompt(plan));
    const verification = await this.verifyWithRetries(agent);
    cost = addCost(cost, verification.cost);

    if (!verification.success) {
      this.send({
        type: "verification_failed",
        attempts: verification.attempts,
        last_error: verification.lastError,
      });
      return;
    }

    this.send({ type: "execution_complete", cost });
  }

  private async verifyWithRetries(agent: AgentDriver): Promise<{
    success: boolean;
    attempts: number;
    lastError: string;
    cost: CostInfo;
  }> {
    const maxAttempts = MAX_VERIFICATION_ATTEMPTS;
    let lastError = "";
    let repairCost: CostInfo = zeroCost();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.send({ type: "verification_started", attempt, max_attempts: maxAttempts });
      const result = await this.verifier.verify(this.requireRepo());
      if (result.success) {
        this.send({
          type: "status",
          message: `Verification passed on attempt ${attempt}/${maxAttempts}.`,
        });
        return { success: true, attempts: attempt, lastError: "", cost: repairCost };
      }

      lastError = formatVerificationFailure(result);
      if (attempt === maxAttempts) {
        return { success: false, attempts: attempt, lastError, cost: repairCost };
      }

      this.send({
        type: "verification_retrying",
        attempt,
        max_attempts: maxAttempts,
        last_error: lastError,
      });
      repairCost = addCost(repairCost, await agent.execute(repairPrompt(attempt, maxAttempts, lastError)));
    }

    return { success: false, attempts: maxAttempts, lastError, cost: repairCost };
  }

  private async handleCreatePullRequest(message: Extract<DOToSandboxMessage, { type: "create_pr" }>): Promise<void> {
    const credential = this.repoUrl ? await this.requestCredential(this.repoUrl) : undefined;
    await this.git.pushBranch({
      cwd: this.requireRepo(),
      branch: message.branch,
      commitMessage: message.commit_message,
      credential,
    });

    this.send({
      type: "branch_pushed",
      branch: message.branch,
      base_branch: this.defaultBranchName ?? "main",
      pr_title: message.pr_title,
      pr_body: message.pr_body,
    });
  }

  private async requestCredential(repo: string): Promise<GitCredential | undefined> {
    if (this.credentialTimeoutMs <= 0) return undefined;
    const request = credentialRequestFromRepo(repo);
    if (!request) return undefined;

    const requestId = `cred_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.send({ type: "credential_request", request_id: requestId, ...request });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.credentialRequests.delete(requestId);
        resolve(undefined);
      }, this.credentialTimeoutMs);

      this.credentialRequests.set(requestId, { resolve, timeout });
    });
  }

  private handleCredentialResponse(message: Extract<DOToSandboxMessage, { type: "credential_response" }>): void {
    const pending = this.credentialRequests.get(message.request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.credentialRequests.delete(message.request_id);

    if (message.error || !message.username || !message.password) {
      this.send({ type: "status", message: `Credential request denied: ${message.error ?? "missing credential"}` });
      pending.resolve(undefined);
      return;
    }

    pending.resolve({ username: message.username, password: message.password });
  }

  private requireRepo(): string {
    if (!this.repoDir) throw new Error("Repository has not been initialized");
    return this.repoDir;
  }

  private requireAgent(): AgentDriver {
    if (!this.agent) throw new Error("Agent session has not been started");
    return this.agent;
  }
}

function credentialRequestFromRepo(repo: string): { protocol: "https"; host: string; path: string } | null {
  try {
    const url = new URL(repo);
    if (url.protocol !== "https:") return null;
    return {
      protocol: "https",
      host: url.hostname,
      path: url.pathname.replace(/^\/+/, ""),
    };
  } catch {
    return null;
  }
}

function planPrompt(prompt: string): string {
  return [
    "You are in PLAN MODE.",
    "Explore this repository and create a detailed implementation plan.",
    "Only output the plan as structured markdown.",
    "",
    prompt,
  ].join("\n");
}

function refinePrompt(feedback: string): string {
  return [
    "Revise the existing plan based on this feedback.",
    "Only output the updated plan as structured markdown.",
    "",
    feedback,
  ].join("\n");
}

function executePrompt(plan: string): string {
  return [
    "Execute this approved plan step by step.",
    "Make the required code changes, then stop.",
    "Do not run dependency installation, CI, test, or lint commands unless the user explicitly asked for that command.",
    "Codevil will run setup and verification after you stop.",
    "",
    plan,
  ].join("\n");
}

function repairPrompt(attempt: number, maxAttempts: number, failure: string): string {
  return [
    `Verification failed after attempt ${attempt}/${maxAttempts}.`,
    "Fix the failure, keep changes scoped to the approved plan, then stop.",
    "",
    failure,
  ].join("\n");
}

function formatVerificationFailure(result: VerificationResult): string {
  return `${result.command} failed:\n${result.output}`.trim();
}

function addCost(left: CostInfo, right: CostInfo): CostInfo {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_cost_usd: Number((left.total_cost_usd + right.total_cost_usd).toFixed(6)),
  };
}

function zeroCost(): CostInfo {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
  };
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

export function detectSetupCommand(cwd: string): string | undefined {
  if (existsSync(join(cwd, ".codevil", "setup.sh"))) {
    return "bash .codevil/setup.sh";
  }

  const packageManager = detectPackageManager(cwd);
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
      switch (detectPackageManager(cwd)) {
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

function detectPackageManager(cwd: string): "pnpm" | "npm" | "yarn" | "bun" | undefined {
  const packageJson = join(cwd, "package.json");
  if (existsSync(packageJson)) {
    const packageManager = readPackageManager(packageJson);
    if (packageManager === "pnpm" || packageManager === "npm" || packageManager === "yarn" || packageManager === "bun") {
      return packageManager;
    }
  }

  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "npm-shrinkwrap.json"))) return "npm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  return undefined;
}

function readPackageManager(packageJson: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { packageManager?: unknown };
    if (typeof parsed.packageManager !== "string") return undefined;
    return parsed.packageManager.split("@", 1)[0];
  } catch {
    return undefined;
  }
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

function formatCommandFailure(label: string, command: string, result: CommandResult): string {
  const output = trimOutput(`${result.stdout}${result.stderr}`);
  return output
    ? `${label} command failed (${command}):\n${output}`
    : `${label} command failed (${command}) with exit code ${result.code}`;
}

export class ShellCommandRunner implements CommandRunner {
  run(command: string, options: { cwd: string; timeoutMs: number; onOutput?: (chunk: string) => void }): Promise<CommandResult> {
    return runShell(command, options.cwd, options.timeoutMs, options.onOutput);
  }
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      detached,
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

function outputLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 500));
}

function trimOutput(output: string): string {
  const maxLength = 32 * 1024;
  if (output.length <= maxLength) return output.trim();
  return output.slice(output.length - maxLength).trim();
}
