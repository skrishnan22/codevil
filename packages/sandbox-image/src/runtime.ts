import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

import type {
  CostInfo,
  DOToSandboxMessage,
  ConsolidationAnnotation,
  PreviewApp,
  PreviewFramework,
  SandboxToDOMessage,
  QuestionOption,
  AnswerableBy,
  ParticipantIdentity,
} from "@codevil/shared";
import {
  MAX_VERIFICATION_ATTEMPTS,
  PiAgentEventSchema,
  parseInbound,
  createTracer,
  setValidationDropSink,
  tracerValidationDropSink,
  type Span,
  type SpanContext,
  type Tracer,
} from "@codevil/shared";
import {
  PreviewManager,
  appToCommand,
  detectPreviewApps,
  type PreviewCommand,
} from "./preview-manager.js";
export { detectPreviewApps, detectPreviewCommand } from "./preview-manager.js";

const AGENT_PREVIEW_KEY = "agent";

export interface AgentStartOptions {
  cwd: string;
  mode: "coding";
  model: string;
  provider: string;
  llmKey?: string;
  onEvent(event: unknown): void;
  createPullRequest(options: CreatePullRequestToolOptions): Promise<{ url: string }>;
  askQuestion?: (params: AskQuestionParams) => Promise<AskQuestionOutcome>;
}

export interface CreatePullRequestToolOptions {
  title: string;
  body: string;
  branch?: string;
  commit_message?: string;
  draft?: boolean;
}

export interface AskQuestionParams {
  question: string;
  context?: string;
  options?: QuestionOption[];
  allow_freeform: boolean;
  allow_multiple: boolean;
  answerable_by: AnswerableBy;
}

export type AskQuestionOutcome =
  | { cancelled: false; option_ids: string[]; freeform?: string; answered_by: ParticipantIdentity }
  | { cancelled: true; reason: string };

export interface TurnResult {
  response: string;
  cost: CostInfo;
}

export interface PlanResult {
  plan: string;
  cost: CostInfo;
}

export interface ConsolidationInput {
  cwd: string;
  run_id: string;
  round: number;
  model: string;
  provider: string;
  llmKey?: string;
  plan: string;
  annotations: ConsolidationAnnotation[];
  askQuestion?: (params: AskQuestionParams) => Promise<AskQuestionOutcome>;
}

export interface ConsolidationResult {
  /** Prose brief emitted by the ask_question-aware consolidation path. */
  brief: string;
  cost: CostInfo;
}

export interface AgentDriver {
  start(options: AgentStartOptions): Promise<void>;
  turn(prompt: string): Promise<TurnResult>;
  plan(prompt: string): Promise<PlanResult>;
  refine(feedback: string): Promise<PlanResult>;
  consolidateAnnotations?(input: ConsolidationInput): Promise<ConsolidationResult>;
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

type RepoState =
  | { state: "uninit" }
  | {
      state: "ready";
      dir: string;
      url: string;
      defaultBranch: string;
      apps: PreviewApp[];
    };

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
  private repo: RepoState = { state: "uninit" };
  private agent: AgentDriver | undefined;
  private activeRunId: string | undefined;
  private preview: PreviewManager | undefined;
  private tracer: Tracer | undefined;
  private credentialRequests = new Map<string, {
    resolve(credential: GitCredential | undefined): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private pullRequestRequests = new Map<string, {
    resolve(result: { url: string }): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private askQuestionRequests = new Map<string, {
    resolve(outcome: AskQuestionOutcome): void;
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
      // Bootstrap or refresh the tracer from any trace_id present on the wire.
      // Init carries it for clone/setup spans; phase-starting messages carry
      // both trace_id and parent_span_id so sandbox spans nest under the DO's
      // phase span.
      if ("trace_id" in message && message.trace_id) {
        this.ensureTracer(message.trace_id);
      }
      const parent: SpanContext | undefined =
        "parent_span_id" in message && message.parent_span_id && this.tracer
          ? { trace_id: this.tracer.trace_id, span_id: message.parent_span_id }
          : undefined;

      switch (message.type) {
        case "init":
          await this.handleInit(message.repo);
          return;
        case "agent_turn":
          await this.handleAgentTurn(message.run_id, message.prompt, message.model, message.provider, parent);
          return;
        case "plan":
          await this.handlePlan(message.run_id, message.prompt, message.model, message.provider, parent);
          return;
        case "refine_plan":
          await this.handleRefine(message.feedback, parent);
          return;
        case "consolidate_annotations":
          await this.handleConsolidateAnnotations(message, parent);
          return;
        case "execute":
          await this.handleExecute(message.plan, message.model, message.provider, parent);
          return;
        case "create_pr":
          await this.handleCreatePullRequest(message, parent);
          return;
        case "credential_response":
          this.handleCredentialResponse(message);
          return;
        case "create_pr_response":
          this.handleCreatePRResponse(message);
          return;
        case "ask_question_response":
          this.handleAskQuestionResponse(message);
          return;
        case "ask_question_cancelled":
          this.handleAskQuestionCancelled(message);
          return;
        case "preview_start":
          await this.handlePreviewStart(message.app_key);
          return;
        case "preview_stop":
          await this.handlePreviewStop();
          return;
      }
    } catch (error) {
      this.send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureTracer(traceId: string): Tracer {
    if (this.tracer && this.tracer.trace_id === traceId) return this.tracer;
    this.tracer = createTracer({ component: "sandbox", trace_id: traceId });
    setValidationDropSink(tracerValidationDropSink(this.tracer));
    return this.tracer;
  }

  async dispose(): Promise<void> {
    await this.preview?.stop();
    await this.agent?.dispose?.();
  }

  private async handleInit(repo: string): Promise<void> {
    const repoDir = join(this.workspace, "repo");

    this.send({ type: "clone_started" });
    const credential = await this.requestCredential(repo);
    await this.maybeSpan("sandbox.clone", { attributes: { repo } }, () =>
      this.git.clone(repo, repoDir, (line) => {
        this.send({ type: "clone_progress", line });
      }, credential),
    );

    await this.maybeSpan("sandbox.setup", {}, () => this.setupRepository(repoDir));

    const defaultBranch = await this.git.defaultBranch(repoDir);
    this.send({ type: "clone_complete" });
    this.send({
      type: "status",
      message: `Repository ready on ${defaultBranch}.`,
    });

    const apps = detectPreviewApps(repoDir);
    this.repo = { state: "ready", dir: repoDir, url: repo, defaultBranch, apps };
    this.send({ type: "preview_apps", apps });
  }

  // Run `fn` inside a span when a tracer exists; otherwise just call it.
  // Lets the sandbox keep functioning when no DO trace context arrived
  // (e.g. old orchestrator deploy or future test harnesses).
  private async maybeSpan<T>(
    name: string,
    options: { attributes?: Record<string, unknown>; parent?: SpanContext },
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.tracer) return fn();
    return this.tracer.span(name, options, fn);
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
    runId: string,
    prompt: string,
    model: string,
    provider: string | undefined,
    parent: SpanContext | undefined,
  ): Promise<void> {
    const repoDir = this.requireRepo().dir;
    const agent = this.agentFactory();
    this.agent = agent;

    await agent.start({
      cwd: repoDir,
      mode: "coding",
      model,
      provider: provider ?? this.provider,
      llmKey: this.llmKey,
      onEvent: (event) => {
        // Validate Pi events at the SDK boundary. Known shapes narrow; unknown
        // event types pass through opaquely so a Pi version bump can't kill
        // the session. Drop+log on truly malformed (non-tagged) events.
        const validated = parseInbound(PiAgentEventSchema, event, "pi_agent_event");
        if (!validated) return;
        this.send({ type: "agent_event", event: validated });
      },
      createPullRequest: (options) => this.createPullRequest(options),
      askQuestion: (params) => this.askQuestionForActiveRun(runId, params),
    });

    this.activeRunId = runId;
    try {
      const result = await this.maybeSpan(
        "llm.plan",
        { parent, attributes: { run_id: runId, model, provider: provider ?? this.provider } },
        () => agent.plan(planPrompt(prompt)),
      );
      this.capturePreviewCommand(result.plan);
      this.send({ type: "plan_ready", ...result });
    } finally {
      this.activeRunId = undefined;
    }
  }

  private async handleAgentTurn(
    runId: string,
    prompt: string,
    model: string,
    provider: string | undefined,
    parent: SpanContext | undefined,
  ): Promise<void> {
    const repoDir = this.requireRepo().dir;
    if (!this.agent) {
      const agent = this.agentFactory();
      await agent.start({
        cwd: repoDir,
        mode: "coding",
        model,
        provider: provider ?? this.provider,
        llmKey: this.llmKey,
        onEvent: (event) => {
          const validated = parseInbound(PiAgentEventSchema, event, "pi_agent_event");
          if (validated) this.send({ type: "agent_event", event: validated });
        },
        createPullRequest: (options) => this.createPullRequest(options),
        askQuestion: (params) => this.askQuestionForActiveRun(runId, params),
      });
      this.agent = agent;
    }

    this.activeRunId = runId;
    try {
      const result = await this.maybeSpan(
        "llm.agent_turn",
        { parent, attributes: { run_id: runId, model, provider: provider ?? this.provider } },
        () => this.requireAgent().turn(prompt),
      );
      this.capturePreviewCommand(result.response);
      this.send({ type: "agent_turn_complete", run_id: runId, ...result });
    } finally {
      this.activeRunId = undefined;
    }
  }

  private async createPullRequest(options: CreatePullRequestToolOptions): Promise<{ url: string }> {
    const repo = this.requireRepo();
    const runId = this.activeRunId;
    if (!runId) throw new Error("Pull requests can only be created during an active agent turn");
    const branch = options.branch?.trim() || `codevil/${slugify(options.title)}-${Date.now()}`;
    const credential = await this.requestCredential(repo.url);
    await this.git.pushBranch({
      cwd: repo.dir,
      branch,
      commitMessage: options.commit_message?.trim() || options.title,
      credential,
    });

    const requestId = `pr_${crypto.randomUUID().replace(/-/g, "")}`;
    this.send({
      type: "create_pr_request",
      run_id: runId,
      request_id: requestId,
      branch,
      base_branch: repo.defaultBranch,
      title: options.title,
      body: options.body,
      draft: options.draft ?? true,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pullRequestRequests.delete(requestId);
        reject(new Error("Timed out waiting for pull request creation"));
      }, 60_000);
      this.pullRequestRequests.set(requestId, { resolve, reject, timeout });
    });
  }

  private handleCreatePRResponse(message: Extract<DOToSandboxMessage, { type: "create_pr_response" }>): void {
    const pending = this.pullRequestRequests.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pullRequestRequests.delete(message.request_id);
    if (message.error || !message.url) {
      pending.reject(new Error(message.error ?? "Pull request creation did not return a URL"));
      return;
    }
    pending.resolve({ url: message.url });
  }

  /**
   * Ask the room a question and block until it is answered or cancelled.
   * No timeout — conflict questions block until the human responds.
   */
  askQuestion(runId: string, params: AskQuestionParams): Promise<AskQuestionOutcome> {
    const requestId = `q_${crypto.randomUUID().replace(/-/g, "")}`;
    this.send({
      type: "ask_question_request",
      request_id: requestId,
      run_id: runId,
      question: params.question,
      context: params.context,
      options: params.options,
      allow_freeform: params.allow_freeform,
      allow_multiple: params.allow_multiple,
      answerable_by: params.answerable_by,
    });
    return new Promise((resolve) => {
      this.askQuestionRequests.set(requestId, { resolve });
    });
  }

  /**
   * Returns a run-bound callback suitable for passing to askQuestionTool.
   * The returned function closes over runId so the tool does not need to
   * know about it directly.
   */
  makeAskQuestion(runId: string): (params: AskQuestionParams) => Promise<AskQuestionOutcome> {
    return (params) => this.askQuestion(runId, params);
  }

  private askQuestionForActiveRun(
    fallbackRunId: string,
    params: AskQuestionParams,
  ): Promise<AskQuestionOutcome> {
    return this.askQuestion(this.activeRunId ?? fallbackRunId, params);
  }

  private handleAskQuestionResponse(message: Extract<DOToSandboxMessage, { type: "ask_question_response" }>): void {
    const pending = this.askQuestionRequests.get(message.request_id);
    if (!pending) return;
    this.askQuestionRequests.delete(message.request_id);
    pending.resolve({
      cancelled: false,
      option_ids: message.option_ids,
      freeform: message.freeform,
      answered_by: message.answered_by,
    });
  }

  private handleAskQuestionCancelled(message: Extract<DOToSandboxMessage, { type: "ask_question_cancelled" }>): void {
    const pending = this.askQuestionRequests.get(message.request_id);
    if (!pending) return;
    this.askQuestionRequests.delete(message.request_id);
    pending.resolve({ cancelled: true, reason: message.reason });
  }

  private async handleRefine(feedback: string, parent: SpanContext | undefined): Promise<void> {
    const agent = this.requireAgent();
    const result = await this.maybeSpan("llm.refine", { parent }, () =>
      agent.refine(refinePrompt(feedback)),
    );
    this.send({ type: "plan_ready", ...result });
  }

  private async handleConsolidateAnnotations(
    message: Extract<DOToSandboxMessage, { type: "consolidate_annotations" }>,
    parent: SpanContext | undefined,
  ): Promise<void> {
    const repoDir = this.requireRepo().dir;
    const agent = this.agentFactory();
    const askQuestion = this.makeAskQuestion(message.run_id);

    try {
      const result = await this.maybeSpan(
        "llm.consolidate_annotations",
        { parent, attributes: { run_id: message.run_id, round: message.round, model: message.model } },
        () => {
          if (agent.consolidateAnnotations) {
            return agent.consolidateAnnotations({
              cwd: repoDir,
              run_id: message.run_id,
              round: message.round,
              model: message.model,
              provider: message.provider ?? this.provider,
              llmKey: this.llmKey,
              plan: message.plan,
              annotations: message.annotations,
              askQuestion,
            });
          }
          return Promise.resolve(fallbackConsolidation(message.annotations));
        },
      );

      this.send({
        type: "consolidation_complete",
        run_id: message.run_id,
        round: message.round,
        brief: result.brief,
        cost: result.cost ?? zeroCost(),
      });
    } catch (error) {
      this.send({
        type: "consolidation_failed",
        run_id: message.run_id,
        round: message.round,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await agent.dispose?.();
    }
  }

  private async handleExecute(
    plan: string,
    model: string,
    provider: string | undefined,
    parent: SpanContext | undefined,
  ): Promise<void> {
    const agent = this.requireAgent();
    await agent.switchToExecution(model, provider ?? this.provider);
    let cost = await this.maybeSpan(
      "llm.execute",
      { parent, attributes: { model, provider: provider ?? this.provider } },
      () => agent.execute(executePrompt(plan)),
    );
    const verification = await this.maybeSpan(
      "sandbox.verify",
      { parent },
      () => this.verifyWithRetries(agent),
    );
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
      const result = await this.verifier.verify(this.requireRepo().dir);
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

  private async handleCreatePullRequest(
    message: Extract<DOToSandboxMessage, { type: "create_pr" }>,
    parent: SpanContext | undefined,
  ): Promise<void> {
    const repo = this.requireRepo();
    const credential = await this.requestCredential(repo.url);
    await this.maybeSpan(
      "sandbox.push_branch",
      { parent, attributes: { branch: message.branch } },
      () =>
        this.git.pushBranch({
          cwd: repo.dir,
          branch: message.branch,
          commitMessage: message.commit_message,
          credential,
        }),
    );

    this.send({
      type: "branch_pushed",
      branch: message.branch,
      base_branch: repo.defaultBranch,
      pr_title: message.pr_title,
      pr_body: message.pr_body,
    });
  }

  private async handlePreviewStart(appKey?: string): Promise<void> {
    if (this.repo.state !== "ready") {
      this.send({ type: "preview_error", message: "Repository is not ready for preview yet." });
      return;
    }
    const { dir: repoDir, apps } = this.repo;

    const app = resolveAppForStart(apps, appKey);
    if (!app) {
      this.send({
        type: "preview_error",
        message: appKey
          ? `Unknown preview app: ${appKey}.`
          : apps.length === 0
            ? "No supported dev-server command detected."
            : "Select a preview app to start.",
      });
      return;
    }

    if (app.framework === "next") {
      await this.ensureNextSwcBinary(repoDir, app.cwd);
    }

    if (!this.preview) {
      this.preview = new PreviewManager({
        cwd: repoDir,
        onStarting: ({ command, port }) => this.send({ type: "preview_starting", command, port }),
        onReady: ({ command, port }) => this.send({ type: "preview_ready", command, port }),
        onLog: (line) => this.send({ type: "status", message: `Preview output: ${line}` }),
        onError: (message) => this.send({ type: "preview_error", message }),
        onStopped: () => this.send({ type: "preview_stopped" }),
      });
    }

    await this.preview.start(appToCommand(app, repoDir));
  }

  private async ensureNextSwcBinary(repoDir: string, appCwd: string): Promise<void> {
    const libc = detectLibc();
    if (!libc) return;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const target = `@next/swc-linux-${arch}-${libc}`;

    const candidates = [
      join(appCwd, "node_modules", target),
      join(repoDir, "node_modules", target),
    ];
    if (candidates.some((path) => existsSync(path))) return;

    this.send({
      type: "status",
      message: `Installing missing Next.js SWC binary (${target})…`,
    });
    const result = await this.commandRunner.run(`npm install --no-save --force ${target}`, {
      cwd: repoDir,
      timeoutMs: 180_000,
    });
    if (result.code !== 0) {
      this.send({
        type: "status",
        message: `Failed to install ${target}: ${trimOutput(result.stderr || result.stdout)}`,
      });
    }
  }


  private async handlePreviewStop(): Promise<void> {
    await this.preview?.stop();
    this.preview = undefined;
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

  private requireRepo(): Extract<RepoState, { state: "ready" }> {
    if (this.repo.state !== "ready") {
      throw new Error("Repository has not been initialized");
    }
    return this.repo;
  }

  private requireAgent(): AgentDriver {
    if (!this.agent) throw new Error("Agent session has not been started");
    return this.agent;
  }

  private capturePreviewCommand(output: string): void {
    const command = parsePreviewSuggestion(output);
    if (!command) return;
    if (this.repo.state !== "ready") return;
    const { dir: repoDir, apps } = this.repo;

    const agentApp: PreviewApp = {
      key: AGENT_PREVIEW_KEY,
      name: "Agent-suggested preview",
      cwd: command.cwd && command.cwd !== "." ? join(repoDir, command.cwd) : repoDir,
      framework: inferFrameworkFromCommand(command.command),
      command: command.command,
      port: command.port,
    };

    const nextApps = [agentApp, ...apps.filter((app) => app.key !== AGENT_PREVIEW_KEY)];
    this.repo = { ...this.repo, apps: nextApps };
    this.send({ type: "preview_apps", apps: nextApps });
    this.send({
      type: "status",
      message: command.cwd && command.cwd !== "."
        ? `Preview command saved: ${command.command} in ${command.cwd} on port ${command.port}.`
        : `Preview command saved: ${command.command} on port ${command.port}.`,
    });
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
    "Also identify the best dev server for live preview. Do not start it.",
    "If there is a relevant UI dev server, include a JSON object anywhere in your response with this exact shape:",
    "{\"preview\":{\"cwd\":\"relative/path/or/.\",\"command\":\"command to run\",\"port\":5173}}",
    "The preview command must bind to 0.0.0.0 and use a non-3000 port.",
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

export function parsePreviewDiscovery(output: string): PreviewCommand | undefined {
  const json = extractJsonObject(output);
  if (!json) return undefined;

  try {
    const parsed = JSON.parse(json) as { cwd?: unknown; command?: unknown; port?: unknown };
    if (typeof parsed.command !== "string" || !parsed.command.trim()) return undefined;
    if (typeof parsed.port !== "number" || !Number.isInteger(parsed.port)) return undefined;
    if (parsed.port < 1024 || parsed.port > 65535 || parsed.port === 3000) return undefined;
    if (parsed.cwd !== undefined && typeof parsed.cwd !== "string") return undefined;
    return {
      cwd: parsed.cwd?.trim() || ".",
      command: parsed.command.trim(),
      port: parsed.port,
    };
  } catch {
    return undefined;
  }
}

export function parsePreviewSuggestion(output: string): PreviewCommand | undefined {
  for (const json of extractJsonCandidates(output)) {
    try {
      const parsed = JSON.parse(json) as { preview?: unknown };
      if (!isRecord(parsed.preview)) continue;
      const command = parsePreviewCommandShape(parsed.preview);
      if (command) return command;
    } catch {
      continue;
    }
  }

  return undefined;
}

function parsePreviewCommandShape(value: Record<string, unknown>): PreviewCommand | undefined {
  if (typeof value.command !== "string" || !value.command.trim()) return undefined;
  if (typeof value.port !== "number" || !Number.isInteger(value.port)) return undefined;
  if (value.port < 1024 || value.port > 65535 || value.port === 3000) return undefined;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
  return {
    cwd: value.cwd?.trim() || ".",
    command: value.command.trim(),
    port: value.port,
  };
}

function extractJsonObject(output: string): string | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced?.[1] ?? output;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }

  const whole = extractJsonObject(output);
  if (whole) candidates.push(whole);
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function detectLibc(): "gnu" | "musl" | undefined {
  if (process.platform !== "linux") return undefined;
  // glibc: /lib/x86_64-linux-gnu/libc.so.6 on Debian/Ubuntu, /lib64/libc.so.6 on RHEL/Fedora.
  if (
    existsSync("/lib/x86_64-linux-gnu/libc.so.6") ||
    existsSync("/lib/aarch64-linux-gnu/libc.so.6") ||
    existsSync("/lib64/libc.so.6")
  ) {
    return "gnu";
  }
  // musl: Alpine ships ld-musl-* alongside libc.so.
  if (
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1")
  ) {
    return "musl";
  }
  return undefined;
}

function inferFrameworkFromCommand(command: string): PreviewFramework {
  if (/\bnext\b/i.test(command)) return "next";
  if (/\bvite\b/i.test(command)) return "vite";
  if (/react-scripts/i.test(command)) return "react-scripts";
  if (/manage\.py\s+runserver/i.test(command)) return "django";
  if (/\brails\b/i.test(command)) return "rails";
  if (/^\s*make\b/i.test(command)) return "make";
  if (/^\s*just\b/i.test(command)) return "just";
  return "npm";
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

function fallbackConsolidation(annotations: ConsolidationAnnotation[]): ConsolidationResult {
  const brief = annotations.map((annotation) => annotation.comment).join("\n\n");
  return {
    brief: brief.length > 0 ? brief : "Refine the plan.",
    cost: zeroCost(),
  };
}

function zeroCost(): CostInfo {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";
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

function resolveAppForStart(apps: PreviewApp[], appKey?: string): PreviewApp | undefined {
  if (appKey) return apps.find((app) => app.key === appKey);
  if (apps.length === 1) return apps[0];
  return apps.find((app) => app.key === AGENT_PREVIEW_KEY);
}
