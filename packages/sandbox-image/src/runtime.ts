import { join } from "node:path";
import { existsSync } from "node:fs";

import type {
  CostInfo,
  DOToSandboxMessage,
  PreviewApp,
  SandboxToDOMessage,
} from "@codevil/shared";
import {
  PiAgentEventSchema,
  parseInbound,
  createTracer,
  setValidationDropSink,
  tracerValidationDropSink,
  type SpanContext,
  type Tracer,
} from "@codevil/shared";
import {
  PreviewManager,
  appToCommand,
  detectPreviewApps,
} from "./preview-manager.js";
import { executePrompt, planPrompt, refinePrompt } from "./prompts.js";
import { parsePreviewSuggestion } from "./preview-parsers.js";
export { parsePreviewCommand, parsePreviewDiscovery, parsePreviewSuggestion } from "./preview-parsers.js";
import {
  type CommandRunner,
  type Verifier,
  RepositoryVerifier,
  ShellCommandRunner,
  detectSetupCommand,
  detectVerificationCommand,
  runVerificationLoop,
} from "./verification.js";
export {
  RepositoryVerifier,
  ShellCommandRunner,
  detectSetupCommand,
  detectVerificationCommand,
} from "./verification.js";
export { detectPreviewApps, detectPreviewCommand } from "./preview-manager.js";

export type {
  AgentStartOptions,
  CreatePullRequestToolOptions,
  AskQuestionParams,
  AskQuestionOutcome,
  TurnResult,
  PlanResult,
  ConsolidationInput,
  ConsolidationResult,
  AgentDriver,
  AgentDriverFactory,
  GitDriver,
  GitCredential,
  PushBranchOptions,
  SandboxRuntimeOptions,
} from "./runtime-types.js";
export { detectLibc } from "./runtime-helpers.js";

import type {
  AgentDriver,
  AgentDriverFactory,
  AskQuestionOutcome,
  AskQuestionParams,
  CreatePullRequestToolOptions,
  GitCredential,
  GitDriver,
  RepoState,
  SandboxRuntimeOptions,
} from "./runtime-types.js";
import {
  AGENT_PREVIEW_KEY,
  addCost,
  credentialRequestFromRepo,
  detectLibc,
  fallbackConsolidation,
  formatCommandFailure,
  inferFrameworkFromCommand,
  outputLines,
  resolveAppForStart,
  slugify,
  trimOutput,
  zeroCost,
} from "./runtime-helpers.js";
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
      assigned_to: params.assigned_to,
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
      () => runVerificationLoop({
        repoDir: this.requireRepo().dir,
        verifier: this.verifier,
        agent,
        events: {
          verification_started: (attempt, max_attempts) => {
            this.send({ type: "verification_started", attempt, max_attempts });
          },
          verification_retrying: (attempt, max_attempts, last_error) => {
            this.send({ type: "verification_retrying", attempt, max_attempts, last_error });
          },
          status: (message) => this.send({ type: "status", message }),
        },
      }),
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
