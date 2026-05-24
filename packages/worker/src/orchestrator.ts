import { DurableObject } from "cloudflare:workers";
import type {
  SessionState,
  DOToCLIEvent,
  CLIToDOMessage,
  DOToSandboxMessage,
  SandboxToDOMessage,
  CostInfo,
} from "@codevil/shared";
import {
  DEFAULT_CONFIG,
  isValidTransition,
  isTerminalState,
  MAX_REFINEMENT_ROUNDS,
  CLIToDOMessageSchema,
  SandboxToDOMessageSchema,
  PersistedDOToCLIEventSchema,
  parseInbound,
  createTracer,
  setValidationDropSink,
  tracerValidationDropSink,
  type Span,
  type Tracer,
} from "@codevil/shared";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  buildSandboxWebSocketUrl,
  mapSandboxMessageToCLIEvents,
  provisionSandbox,
  readProcessLogs,
} from "./sandbox.js";
import { createDraftPullRequest, credentialRequestAllowed } from "./github.js";
import { redactEvent } from "./redaction.js";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  CODEVIL_API_KEY: string;
  CODEVIL_LLM_KEY?: string;
  GITHUB_PAT?: string;
  CODEVIL_PREVIEW_ORIGIN?: string;
}

interface SessionMeta {
  session_id: string;
  prompt: string;
  repo: string;
  worker_url: string;
  provider: string;
  plan_model: string;
  exec_model: string;
  max_cost: string;
  max_time: string;
  max_steps: number;
  state: SessionState;
  refinement_round: number;
  verification_attempts: number;
  cost_total_usd: number;
  latest_plan?: string;
  preview_token_hash?: string;
  preview_url?: string;
  preview_port?: number;
  preview_active?: boolean;
  created_at: string;
  expected_close?: boolean;
}

export interface InitOptions {
  worker_url: string;
  provider?: string;
  plan_model?: string;
  exec_model?: string;
  max_cost?: string;
  max_time?: string;
  max_steps?: number;
}

// State → phase span name. Phase spans live across multiple WS messages,
// so we hold the open Span on the DO instance and end it on transition out.
const PHASE_SPAN_NAMES: Partial<Record<SessionState, string>> = {
  planning: "phase.plan",
  refining: "phase.refine",
  executing: "phase.execute",
  verifying: "phase.verify",
  creating_pr: "phase.create_pr",
};

export class Orchestrator extends DurableObject<Env> {
  private sql: SqlStorage;
  private meta: SessionMeta | null = null;
  private workerEnv: Env;
  private redactionSecrets: string[];
  private tracer: Tracer | null = null;
  private phaseSpans = new Map<SessionState, Span>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workerEnv = env;
    this.redactionSecrets = [env.CODEVIL_API_KEY, env.CODEVIL_LLM_KEY, env.GITHUB_PAT].filter((secret): secret is string => Boolean(secret));
    this.sql = ctx.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async init(sessionId: string, prompt: string, repo: string, options: InitOptions): Promise<void> {
    this.meta = {
      session_id: sessionId,
      prompt,
      repo,
      worker_url: options.worker_url,
      provider: options.provider ?? DEFAULT_CONFIG.provider,
      plan_model: options.plan_model ?? DEFAULT_CONFIG.plan_model,
      exec_model: options.exec_model ?? DEFAULT_CONFIG.exec_model,
      max_cost: options.max_cost ?? DEFAULT_CONFIG.max_cost,
      max_time: options.max_time ?? DEFAULT_CONFIG.max_time,
      max_steps: options.max_steps ?? DEFAULT_CONFIG.max_steps,
      state: "initializing",
      refinement_round: 0,
      verification_attempts: 0,
      cost_total_usd: 0,
      created_at: new Date().toISOString(),
    };
    this.saveMeta();

    this.appendAndBroadcast({ type: "session_created", session_id: sessionId });
    this.appendAndBroadcast({ type: "status", message: "Session created. Waiting for sandbox provisioning." });
    this.ctx.waitUntil(this.provisionSessionSandbox());
    void this.armNextAlarm();
  }

  async alarm(): Promise<void> {
    this.loadMeta();
    if (!this.meta) return;
    if (isTerminalState(this.meta.state)) return;

    const now = Date.now();
    const createdAt = Date.parse(this.meta.created_at);
    const maxTimeMs = parseMaxTimeMs(this.meta.max_time);
    if (maxTimeMs !== null && now >= createdAt + maxTimeMs) {
      this.transition("timed_out");
      this.appendAndBroadcast({
        type: "error",
        message: `Session timed out after ${this.meta.max_time}.`,
      });
      await this.terminateSandbox("timed out");
      return;
    }

    if (this.meta.state === "provisioning_sandbox" && now >= createdAt + 60_000) {
      const logs = await readProcessLogs(this.workerEnv.Sandbox, this.meta.session_id, "codevil-agent");
      this.getTracer()?.log("ERROR", "sandbox.timeout", {
        stdout: logs?.stdout ?? "(none)",
        stderr: logs?.stderr ?? "(none)",
      });
      this.transition("timed_out");

      const output = [logs?.stdout, logs?.stderr].filter(Boolean).join("\n").trim();
      this.appendAndBroadcast({
        type: "error",
        message: output
          ? `Sandbox process failed:\n${output}`
          : "Sandbox failed to connect within 60 seconds. No process output captured.",
      });
      await this.terminateSandbox("timed out");
      return;
    }

    void this.armNextAlarm(now);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isSandbox = url.pathname.endsWith("/sandbox/ws");

    if (isSandbox) {
      return this.acceptSandboxWebSocket();
    }

    const cursorParam = url.searchParams.get("cursor");
    const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["cli"]);
    this.replayEvents(server, cursor);

    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptSandboxWebSocket(): Response {
    this.loadMeta();
    this.getTracer()?.log("INFO", "sandbox.ws.connected", {
      state: this.meta?.state,
    });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["sandbox"]);
    this.startPlanning(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    if (this.ctx.getWebSockets("sandbox").includes(ws)) {
      await this.handleSandboxSocketMessage(ws, message);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }
    const msg = parseInbound(CLIToDOMessageSchema, raw, "cli_to_do");
    if (!msg) return;

    this.loadMeta();
    if (!this.meta) {
      ws.send(JSON.stringify({ type: "error", message: "Session not initialized" }));
      return;
    }

    switch (msg.type) {
      case "approve":
        this.handleApprove();
        break;
      case "abort":
        this.handleAbort();
        break;
      case "stop_session":
        await this.handleStopSession();
        break;
      case "refine_plan":
        this.handleRefine(msg.feedback);
        break;
      case "preview_start":
        await this.handlePreviewStart(msg.app_key);
        break;
      case "preview_stop":
        await this.handlePreviewStop();
        break;
      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown message type` }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const isSandbox = this.ctx.getWebSockets("sandbox").includes(ws);
    this.loadMeta();
    this.getTracer()?.log("INFO", "ws.close", {
      source: isSandbox ? "sandbox" : "cli",
      code,
      reason,
      state: this.meta?.state,
    });

    if (isSandbox && this.meta) {
      this.revokePreview();
      if (!this.meta.expected_close && !isTerminalState(this.meta.state) && this.meta.state !== "awaiting_approval") {
        this.transition("failed");
        this.appendAndBroadcast({
          type: "error",
          message: `Sandbox disconnected unexpectedly (code: ${code}, reason: ${reason || "none"}).`,
        });
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const isSandbox = this.ctx.getWebSockets("sandbox").includes(ws);
    this.loadMeta();
    this.getTracer()?.log("ERROR", "ws.error", {
      source: isSandbox ? "sandbox" : "cli",
      error: error instanceof Error ? error.message : String(error),
    });
    try { ws.close(1011, "WebSocket error"); } catch { /* already closed */ }
  }

  // --- State transitions ---

  transition(to: SessionState): boolean {
    this.loadMeta();
    if (!this.meta) return false;

    const from = this.meta.state;
    if (!isValidTransition(from, to)) {
      this.appendAndBroadcast({
        type: "error",
        message: `Invalid transition: ${from} → ${to}`,
      });
      return false;
    }

    this.meta.state = to;
    this.saveMeta();

    // Close span for the state we just left; open one for the state we entered.
    const leavingSpan = this.phaseSpans.get(from);
    if (leavingSpan) {
      this.phaseSpans.delete(from);
      leavingSpan.end();
    }
    const enteringName = PHASE_SPAN_NAMES[to];
    if (enteringName) {
      const tracer = this.getTracer();
      if (tracer) {
        const span = tracer.startSpan(enteringName, { attributes: { state: to } });
        this.phaseSpans.set(to, span);
      }
    }
    if (isTerminalState(to)) {
      // Drop any phase spans still open (e.g. on `failed` from mid-phase).
      for (const [state, span] of this.phaseSpans) {
        span.setStatus("ERROR", `terminal: ${to}`);
        span.end();
        this.phaseSpans.delete(state);
      }
    }

    this.getTracer()?.log("INFO", "state.transition", { from, to });
    return true;
  }

  private getTracer(): Tracer | null {
    if (this.tracer) return this.tracer;
    this.loadMeta();
    if (!this.meta) return null;
    this.tracer = createTracer({
      component: "orchestrator",
      trace_id: traceIdFromSessionId(this.meta.session_id),
    });
    setValidationDropSink(tracerValidationDropSink(this.tracer));
    return this.tracer;
  }

  private currentPhaseSpan(): Span | undefined {
    if (!this.meta) return undefined;
    return this.phaseSpans.get(this.meta.state);
  }

  private handleApprove(): void {
    if (!this.meta) return;

    if (this.meta.state !== "awaiting_approval") {
      this.appendAndBroadcast({
        type: "error",
        message: `Cannot approve in state: ${this.meta.state}`,
      });
      return;
    }

    if (this.transition("executing")) {
      this.appendAndBroadcast({
        type: "status",
        message: "Plan approved. Starting execution.",
      });
      this.sendToSandbox({
        type: "execute",
        plan: this.meta.latest_plan ?? "",
        model: this.meta.exec_model,
        provider: this.meta.provider,
      });
    }
  }

  private handleAbort(): void {
    if (!this.meta) return;

    if (isTerminalState(this.meta.state)) {
      this.appendAndBroadcast({
        type: "error",
        message: `Session already in terminal state: ${this.meta.state}`,
      });
      return;
    }

    if (this.transition("failed")) {
      this.appendAndBroadcast({
        type: "status",
        message: "Session aborted by user.",
      });
      // Preview stays alive; user can keep iterating in the iframe until they
      // press "Stop Session" or the container hits idle/max timeout.
    }
  }

  private async handleStopSession(): Promise<void> {
    if (!this.meta) return;
    if (!isTerminalState(this.meta.state)) {
      this.transition("failed");
    }
    this.appendAndBroadcast({
      type: "status",
      message: "Stopping sandbox container…",
    });
    this.revokePreview();
    await this.terminateSandbox("stopped by user");
  }

  private async terminateSandbox(reason: string): Promise<void> {
    if (!this.meta) return;
    this.meta.expected_close = true;
    this.saveMeta();
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(this.workerEnv.Sandbox, this.meta.session_id);
      await sandbox.stop();
    } catch (error) {
      this.getTracer()?.log("ERROR", "sandbox.stop.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.closeSandboxSockets(reason);
  }

  private handleRefine(feedback: string): void {
    if (!this.meta) return;

    if (this.meta.state !== "awaiting_approval") {
      this.appendAndBroadcast({
        type: "error",
        message: `Cannot refine in state: ${this.meta.state}`,
      });
      return;
    }

    if (this.meta.refinement_round >= MAX_REFINEMENT_ROUNDS) {
      this.appendAndBroadcast({
        type: "error",
        message: `Maximum refinement rounds (${MAX_REFINEMENT_ROUNDS}) reached.`,
      });
      return;
    }

    if (this.transition("refining")) {
      this.meta.refinement_round++;
      this.saveMeta();
      this.appendAndBroadcast({
        type: "status",
        message: `Refining plan (round ${this.meta.refinement_round}/${MAX_REFINEMENT_ROUNDS}): ${feedback}`,
      });
      this.sendToSandbox({ type: "refine_plan", feedback });
    }
  }

  private async provisionSessionSandbox(): Promise<void> {
    this.loadMeta();
    if (!this.meta) return;

    if (!this.transition("provisioning_sandbox")) return;

    const tracer = this.getTracer();
    try {
      const wsUrl = buildSandboxWebSocketUrl(this.meta.worker_url, this.meta.session_id);
      await tracer!.span(
        "sandbox.provision",
        {
          attributes: {
            provider: this.meta.provider,
            plan_model: this.meta.plan_model,
            has_llm_key: Boolean(this.workerEnv.CODEVIL_LLM_KEY),
          },
        },
        () =>
          provisionSandbox({
            binding: this.workerEnv.Sandbox,
            sessionId: this.meta!.session_id,
            wsUrl,
            apiKey: this.workerEnv.CODEVIL_API_KEY,
            provider: this.meta!.provider,
            llmKey: this.workerEnv.CODEVIL_LLM_KEY,
          }),
      );
      this.appendAndBroadcast({ type: "status", message: "Sandbox process started." });
    } catch (error) {
      tracer?.log("ERROR", "sandbox.provision.failed", {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.transition("failed");
      this.appendAndBroadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startPlanning(ws: WebSocket): void {
    this.loadMeta();
    if (!this.meta) {
      console.error("codevil.startPlanning.no_meta");
      return;
    }

    const tracer = this.getTracer();
    tracer?.log("INFO", "start_planning", {
      state: this.meta.state,
      provider: this.meta.provider,
      plan_model: this.meta.plan_model,
    });

    if (this.meta.state !== "provisioning_sandbox") {
      tracer?.log("ERROR", "start_planning.unexpected_state", {
        state: this.meta.state,
        expected: "provisioning_sandbox",
      });
      this.appendAndBroadcast({
        type: "error",
        message: `Sandbox connected in unexpected state: ${this.meta.state}`,
      });
      return;
    }

    ws.send(JSON.stringify({
      type: "init",
      repo: this.meta.repo,
      ...(tracer ? { trace_id: tracer.trace_id } : {}),
    } satisfies DOToSandboxMessage));
  }

  private async handleSandboxSocketMessage(ws: WebSocket, message: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }
    const parsed = parseInbound(SandboxToDOMessageSchema, raw, "sandbox_to_do");
    if (!parsed) return;

    this.loadMeta();
    this.getTracer()?.log("DEBUG", "sandbox.message", {
      type: parsed.type,
      state: this.meta?.state,
    });
    if (!this.meta) return;

    switch (parsed.type) {
      case "clone_started":
        this.handleSandboxCloneStarted();
        return;
      case "clone_complete":
        this.handleSandboxCloneComplete();
        return;
      case "plan_ready":
        this.handleSandboxPlanReady(parsed.plan, parsed.cost);
        return;
      case "verification_started":
        this.handleSandboxVerificationStarted(parsed.attempt, parsed.max_attempts);
        return;
      case "verification_retrying":
        this.handleSandboxVerificationRetrying(parsed.attempt, parsed.max_attempts, parsed.last_error);
        return;
      case "execution_complete":
        this.handleSandboxExecutionComplete(parsed.cost);
        return;
      case "verification_failed":
        this.handleSandboxVerificationFailed(parsed.attempts, parsed.last_error);
        return;
      case "credential_request":
        this.handleCredentialRequest(ws, parsed);
        return;
      case "branch_pushed":
        await this.handleBranchPushed(parsed.branch, parsed.base_branch, parsed.pr_title, parsed.pr_body);
        return;
      case "pr_created":
        if (this.transition("completed")) {
          this.appendAndBroadcast({ type: "complete", pr_url: parsed.url });
        }
        return;
      case "preview_starting":
        this.appendAndBroadcast({ type: "preview_starting", command: parsed.command, port: parsed.port });
        return;
      case "preview_ready":
        await this.handleSandboxPreviewReady(parsed.command, parsed.port);
        return;
      case "preview_error":
        this.revokePreview();
        this.appendAndBroadcast({ type: "preview_error", message: parsed.message });
        return;
      case "preview_stopped":
        this.revokePreview();
        this.appendAndBroadcast({ type: "preview_stopped" });
        return;
      case "preview_apps":
        this.appendAndBroadcast({ type: "preview_apps", apps: parsed.apps });
        return;
      case "error":
        this.transition("failed");
        this.appendAndBroadcast({ type: "error", message: parsed.message });
        return;
      default:
        for (const event of mapSandboxMessageToCLIEvents(parsed)) {
          this.appendAndBroadcast(event);
        }
    }
  }

  private handleSandboxCloneStarted(): void {
    if (!this.meta) return;
    if (this.meta.state !== "provisioning_sandbox") return;
    this.transition("cloning_repo");
  }

  private handleSandboxCloneComplete(): void {
    if (!this.meta) return;
    if (this.meta.state !== "cloning_repo") return;

    if (this.transition("planning")) {
      this.appendAndBroadcast({
        type: "phase",
        phase: "planning",
        model: this.meta.plan_model,
      });
      this.sendToSandbox({
        type: "plan",
        prompt: this.meta.prompt,
        model: this.meta.plan_model,
        provider: this.meta.provider,
      });
    }
  }

  private handleSandboxPlanReady(plan: string, cost: CostInfo): void {
    if (!this.meta) return;

    this.meta.latest_plan = plan;
    this.saveMeta();

    if (!this.recordCost(cost)) return;

    if (this.meta.state === "planning") {
      if (this.transition("awaiting_approval")) {
        this.appendAndBroadcast({
          type: "plan_ready",
          plan,
          cost,
          refinement_round: this.meta.refinement_round,
        });
        this.appendAndBroadcast({ type: "status", message: "Waiting for user approval." });
      }
      return;
    }

    if (this.meta.state === "refining") {
      if (this.transition("awaiting_approval")) {
        this.appendAndBroadcast({
          type: "plan_ready",
          plan,
          cost,
          refinement_round: this.meta.refinement_round,
        });
        this.appendAndBroadcast({ type: "status", message: "Waiting for user approval." });
      }
    }
  }

  private handleSandboxVerificationStarted(attempt: number, maxAttempts: number): void {
    if (!this.meta) return;
    if (this.meta.state === "executing" || this.meta.state === "retrying") {
      this.meta.verification_attempts = attempt;
      this.saveMeta();
      if (this.transition("verifying")) {
        this.appendAndBroadcast({
          type: "status",
          message: `Verification started (attempt ${attempt}/${maxAttempts}).`,
        });
      }
      return;
    }

    if (this.meta.state === "verifying") {
      this.meta.verification_attempts = attempt;
      this.saveMeta();
    }
  }

  private handleSandboxVerificationRetrying(attempt: number, maxAttempts: number, _lastError: string): void {
    if (!this.meta) return;
    if (this.meta.state !== "verifying") return;

    this.meta.verification_attempts = attempt;
    this.saveMeta();
    if (this.transition("retrying")) {
      this.appendAndBroadcast({
        type: "status",
        message: `Verification failed on attempt ${attempt}/${maxAttempts}. Asking agent to fix it.`,
      });
    }
  }

  private handleSandboxExecutionComplete(cost: CostInfo): void {
    if (!this.meta) return;
    if (!this.recordCost(cost)) return;
    if (this.meta.state !== "verifying") return;

    if (this.transition("creating_pr")) {
      this.appendAndBroadcast({ type: "status", message: "Execution completed. Creating pull request." });
      this.sendToSandbox({
        type: "create_pr",
        branch: `codevil/${slugify(this.meta.prompt)}-${Date.now()}`,
        commit_message: `Implement ${this.meta.prompt}`,
        pr_title: this.meta.prompt,
        pr_body: this.meta.latest_plan ?? this.meta.prompt,
      });
    }
  }

  private handleCredentialRequest(ws: WebSocket, request: Extract<SandboxToDOMessage, { type: "credential_request" }>): void {
    if (!this.meta) return;

    if (!this.workerEnv.GITHUB_PAT) {
      ws.send(JSON.stringify({
        type: "credential_response",
        request_id: request.request_id,
        error: "GitHub credentials are not configured.",
      } satisfies DOToSandboxMessage));
      return;
    }

    if (!credentialRequestAllowed(this.meta.repo, request)) {
      ws.send(JSON.stringify({
        type: "credential_response",
        request_id: request.request_id,
        error: "Credential request does not match this session repository.",
      } satisfies DOToSandboxMessage));
      return;
    }

    ws.send(JSON.stringify({
      type: "credential_response",
      request_id: request.request_id,
      username: "x-access-token",
      password: this.workerEnv.GITHUB_PAT,
    } satisfies DOToSandboxMessage));
  }

  private async handleBranchPushed(branch: string, baseBranch: string, prTitle: string, prBody: string): Promise<void> {
    if (!this.meta) return;
    if (this.meta.state !== "creating_pr") return;

    try {
      if (!this.workerEnv.GITHUB_PAT) throw new Error("GitHub credentials are not configured.");
      const prUrl = await createDraftPullRequest({
        repo: this.meta.repo,
        token: this.workerEnv.GITHUB_PAT,
        branch,
        baseBranch,
        title: prTitle,
        body: prBody,
      });

      if (this.transition("completed")) {
        this.appendAndBroadcast({ type: "complete", pr_url: prUrl });
      }
    } catch (error) {
      this.transition("failed");
      this.appendAndBroadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleSandboxVerificationFailed(attempts: number, lastError: string): void {
    if (!this.meta) return;
    if (this.meta.state === "verifying") {
      this.appendAndBroadcast({
        type: "verification_failed",
        attempts,
        last_error: lastError,
      });
      this.transition("failed");
    }
  }

  private async handlePreviewStart(appKey?: string): Promise<void> {
    if (!this.meta) return;

    this.sendToSandbox({
      type: "preview_start",
      model: this.meta.plan_model,
      provider: this.meta.provider,
      task_prompt: this.meta.prompt,
      app_key: appKey,
    });
  }

  private async handlePreviewStop(): Promise<void> {
    this.revokePreview();
    this.sendToSandbox({ type: "preview_stop" });
  }

  private async handleSandboxPreviewReady(command: string, port: number): Promise<void> {
    if (!this.meta) return;
    const token = createPreviewToken(this.meta.session_id);
    this.meta.preview_token_hash = await hashPreviewToken(token);
    this.meta.preview_url = buildPreviewUrl({
      workerOrigin: this.meta.worker_url,
      previewOrigin: this.workerEnv.CODEVIL_PREVIEW_ORIGIN,
      sessionId: this.meta.session_id,
      token,
    });
    this.meta.preview_port = port;
    this.meta.preview_active = true;
    this.saveMeta();
    this.appendAndBroadcast({
      type: "preview_ready",
      url: this.meta.preview_url,
      command,
      port,
    });
  }

  private revokePreview(): void {
    if (!this.meta) return;
    this.meta.preview_active = false;
    this.meta.preview_token_hash = undefined;
    this.meta.preview_url = undefined;
    this.meta.preview_port = undefined;
    this.saveMeta();
  }

  private recordCost(cost: CostInfo): boolean {
    if (!this.meta) return false;

    this.meta.cost_total_usd = (this.meta.cost_total_usd ?? 0) + cost.total_cost_usd;
    this.saveMeta();

    const maxCost = parseMaxCostUsd(this.meta.max_cost);
    if (maxCost === null || this.meta.cost_total_usd <= maxCost) return true;

    if (this.transition("cost_exceeded")) {
      this.appendAndBroadcast({
        type: "error",
        message: `Cost limit exceeded: $${this.meta.cost_total_usd.toFixed(4)} used, limit $${maxCost.toFixed(2)}.`,
      });
    }
    return false;
  }

  private sendToSandbox(message: DOToSandboxMessage): void {
    const sandboxes = this.ctx.getWebSockets("sandbox");
    if (sandboxes.length === 0) {
      this.appendAndBroadcast({ type: "error", message: "Sandbox is not connected." });
      return;
    }

    const enriched = this.withTraceContext(message);
    for (const sandbox of sandboxes) {
      sandbox.send(JSON.stringify(enriched));
    }
  }

  // Attach trace_id + parent_span_id so the sandbox can nest its child spans
  // under the active phase span. Only meaningful for phase-starting message
  // types; the schemas accept the fields as optional.
  private withTraceContext(message: DOToSandboxMessage): DOToSandboxMessage {
    const tracer = this.getTracer();
    if (!tracer) return message;
    if (
      message.type !== "plan" &&
      message.type !== "execute" &&
      message.type !== "refine_plan" &&
      message.type !== "create_pr" &&
      message.type !== "preview_start"
    ) {
      return message;
    }
    const parent = this.currentPhaseSpan()?.context();
    return {
      ...message,
      trace_id: tracer.trace_id,
      ...(parent ? { parent_span_id: parent.span_id } : {}),
    };
  }

  private closeSandboxSockets(reason: string): void {
    for (const sandbox of this.ctx.getWebSockets("sandbox")) {
      sandbox.close(1000, reason);
    }
  }

  private async armNextAlarm(now = Date.now()): Promise<void> {
    if (!this.meta || isTerminalState(this.meta.state)) return;

    const createdAt = Date.parse(this.meta.created_at);
    const deadlines = [createdAt + 60_000];
    const maxTimeMs = parseMaxTimeMs(this.meta.max_time);
    if (maxTimeMs !== null) deadlines.push(createdAt + maxTimeMs);

    const nextDeadline = Math.min(...deadlines.filter((deadline) => deadline > now));
    if (Number.isFinite(nextDeadline)) {
      await this.ctx.storage.setAlarm(nextDeadline);
    }
  }

  // --- Test simulation ---

  async simulateTestEvents(): Promise<void> {
    this.loadMeta();
    if (!this.meta) return;

    const steps: { state: SessionState; event: DOToCLIEvent }[] = [
      { state: "provisioning_sandbox", event: { type: "status", message: "Provisioning sandbox..." } },
      { state: "cloning_repo", event: { type: "clone_progress", line: "Cloning into '/workspace'..." } },
      { state: "planning", event: { type: "phase", phase: "planning", model: "claude-sonnet-4-6" } },
      { state: "awaiting_approval", event: { type: "plan_ready", plan: "## Test Plan\n\n1. Step one\n2. Step two", cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.01 }, refinement_round: 0 } },
    ];

    for (const step of steps) {
      if (this.transition(step.state)) {
        this.appendAndBroadcast(step.event);
      }
    }
    this.appendAndBroadcast({ type: "status", message: "Waiting for user approval." });
  }

  async fetchPreview(request: Request, token: string): Promise<Response> {
    this.loadMeta();
    if (!this.meta || !this.meta.preview_active || !this.meta.preview_port || !this.meta.preview_token_hash) {
      return new Response("Preview is not active.", { status: 404 });
    }

    if (isTerminalState(this.meta.state)) {
      return new Response("Preview session has ended.", { status: 410 });
    }

    const tokenHash = await hashPreviewToken(token);
    if (tokenHash !== this.meta.preview_token_hash) {
      return new Response("Unknown preview token.", { status: 404 });
    }

    const originalUrl = new URL(request.url);
    const prefix = `/sessions/${this.meta.session_id}/preview/${token}`;
    const path = originalUrl.pathname.startsWith(prefix)
      ? originalUrl.pathname.slice(prefix.length) || "/"
      : originalUrl.pathname;
    // Build a clean path (no `/proxy/<port>` prefix) so the dev server sees what the
    // browser asked for. Sandbox.containerFetch routes the request to the given port.
    const proxyUrl = new URL(path, "http://localhost");
    proxyUrl.search = originalUrl.search;

    // `new Request(url, originalRequest)` is the documented pattern for proxying
    // with URL rewrite. It preserves Cloudflare-internal upgrade semantics that
    // `new Request(url, { headers, body })` drops, which is what makes HMR work.
    const proxyRequest = new Request(proxyUrl, request);

    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(this.workerEnv.Sandbox, this.meta.session_id);
    // Use sandbox.fetch() (legacy DO fetch protocol) instead of containerFetch
    // (JSRPC), because JSRPC cannot carry a WebSocket pair across the DO
    // boundary — HMR upgrades silently lose their socket. The
    // cf-container-target-port header tells our Sandbox subclass which dev
    // server port to route to.
    const portedHeaders = new Headers(proxyRequest.headers);
    portedHeaders.set("cf-container-target-port", String(this.meta.preview_port));
    const portedRequest = new Request(proxyRequest, { headers: portedHeaders });
    const response = await sandbox.fetch(portedRequest);

    // For WebSocket upgrade responses (HMR, Vite HMR, etc.), we must NOT
    // reconstruct the Response: `new Response(body, init)` does not propagate
    // the `webSocket` field that carries the established socket pair, so the
    // upgrade silently fails. Pass the 101 through untouched.
    if (response.status === 101) return response;

    const patched = new Response(response.body, response);
    patched.headers.set("Cache-Control", "no-store");
    return patched;
  }

  // --- Event log ---

  private appendAndBroadcast(event: DOToCLIEvent): void {
    const redacted = redactEvent(event, this.redactionSecrets);
    const json = JSON.stringify(redacted);
    this.sql.exec("INSERT INTO events (event_json) VALUES (?)", json);

    const row = this.sql.exec(
      "SELECT id FROM events ORDER BY id DESC LIMIT 1"
    ).one() as { id: number };

    const envelope = JSON.stringify({ cursor: row.id, event: redacted });
    for (const ws of this.ctx.getWebSockets("cli")) {
      ws.send(envelope);
    }
  }

  private replayEvents(ws: WebSocket, afterCursor: number): void {
    for (const row of this.sql.exec(
      "SELECT id, event_json FROM events WHERE id > ? ORDER BY id ASC",
      afterCursor,
    )) {
      const id = row["id"] as number;
      const eventJson = row["event_json"] as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(eventJson);
      } catch {
        continue;
      }
      // Lenient on replay: only require a tagged object so a schema change
      // doesn't kill reconnects against history written by a prior deploy.
      const event = parseInbound(PersistedDOToCLIEventSchema, parsed, "persisted_replay");
      if (!event) continue;
      ws.send(JSON.stringify({ cursor: id, event }));
    }
  }

  // --- Meta persistence ---

  private saveMeta(): void {
    if (!this.meta) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO session_meta (key, value) VALUES ('meta', ?)`,
      JSON.stringify(this.meta),
    );
  }

  private loadMeta(): void {
    if (this.meta) return;
    const row = this.sql.exec(
      "SELECT value FROM session_meta WHERE key = 'meta'"
    );
    for (const r of row) {
      this.meta = JSON.parse(r["value"] as string);
      break;
    }
  }
}

function parseMaxCostUsd(value: string): number | null {
  const match = value.trim().match(/^\$?(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  return Number(match[1]);
}

function parseMaxTimeMs(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return null;
  }
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 48) || "task";
}

function createPreviewToken(sessionId: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${sessionId.replace(/^ses_/, "ses-")}-${random}`;
}

async function hashPreviewToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildPreviewUrl(options: {
  workerOrigin: string;
  previewOrigin: string | undefined;
  sessionId: string;
  token: string;
}): string {
  const origin = normalizeOrigin(options.previewOrigin ?? options.workerOrigin);
  const url = new URL(origin);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.pathname = `/sessions/${options.sessionId}/preview/${options.token}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  if (!options.previewOrigin || url.hostname.endsWith(".workers.dev")) {
    const workerUrl = new URL(normalizeOrigin(options.workerOrigin));
    workerUrl.pathname = `/sessions/${options.sessionId}/preview/${options.token}/`;
    workerUrl.search = "";
    workerUrl.hash = "";
    return workerUrl.toString();
  }

  url.hostname = `${options.token}.${url.hostname}`;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeOrigin(origin: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`;
}

// trace_id is 32 hex chars (16 bytes) per OTLP. Session IDs are
// "ses_<32-hex>"; strip the prefix so every emit converges on one trace.
export function traceIdFromSessionId(sessionId: string): string {
  const hex = sessionId.replace(/^ses_/, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? hex.toLowerCase() : hex.padEnd(32, "0").slice(0, 32);
}
