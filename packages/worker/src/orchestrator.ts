import { DurableObject } from "cloudflare:workers";
import type {
  SessionState,
  DOToCLIEvent,
  CLIToDOMessage,
  DOToSandboxMessage,
  SandboxToDOMessage,
  CostInfo,
} from "@codevil/shared";
import { DEFAULT_CONFIG, isValidTransition, isTerminalState, MAX_REFINEMENT_ROUNDS } from "@codevil/shared";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  buildSandboxWebSocketUrl,
  mapSandboxMessageToCLIEvents,
  provisionSandbox,
  readProcessLogs,
} from "./sandbox.js";
import { redactEvent } from "./redaction.js";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  CODEVIL_API_KEY: string;
  CODEVIL_LLM_KEY?: string;
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
  created_at: string;
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

export class Orchestrator extends DurableObject<Env> {
  private sql: SqlStorage;
  private meta: SessionMeta | null = null;
  private workerEnv: Env;
  private redactionSecrets: string[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workerEnv = env;
    this.redactionSecrets = [env.CODEVIL_API_KEY, env.CODEVIL_LLM_KEY].filter((secret): secret is string => Boolean(secret));
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
      this.closeSandboxSockets("timed out");
      return;
    }

    if (this.meta.state === "provisioning_sandbox" && now >= createdAt + 60_000) {
      const logs = await readProcessLogs(this.workerEnv.Sandbox, this.meta.session_id, "codevil-agent");
      console.error("codevil.sandbox.timeout", {
        session_id: this.meta.session_id,
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
      this.closeSandboxSockets("timed out");
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
    console.log("codevil.sandbox.ws.connected", {
      session_id: this.meta?.session_id,
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
      this.handleSandboxSocketMessage(ws, message);
      return;
    }

    let msg: CLIToDOMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

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
      case "refine_plan":
        this.handleRefine(msg.feedback);
        break;
      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown message type` }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const isSandbox = this.ctx.getWebSockets("sandbox").includes(ws);
    this.loadMeta();
    console.log("codevil.ws.close", {
      session_id: this.meta?.session_id,
      source: isSandbox ? "sandbox" : "cli",
      code,
      reason,
      state: this.meta?.state,
    });

    if (isSandbox && this.meta && !isTerminalState(this.meta.state) && this.meta.state !== "awaiting_approval") {
      this.transition("failed");
      this.appendAndBroadcast({
        type: "error",
        message: `Sandbox disconnected unexpectedly (code: ${code}, reason: ${reason || "none"}).`,
      });
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const isSandbox = this.ctx.getWebSockets("sandbox").includes(ws);
    this.loadMeta();
    console.error("codevil.ws.error", {
      session_id: this.meta?.session_id,
      source: isSandbox ? "sandbox" : "cli",
      error: error instanceof Error ? error.message : String(error),
    });
    try { ws.close(1011, "WebSocket error"); } catch { /* already closed */ }
  }

  // --- State transitions ---

  transition(to: SessionState): boolean {
    this.loadMeta();
    if (!this.meta) return false;

    if (!isValidTransition(this.meta.state, to)) {
      this.appendAndBroadcast({
        type: "error",
        message: `Invalid transition: ${this.meta.state} → ${to}`,
      });
      return false;
    }

    this.meta.state = to;
    this.saveMeta();
    return true;
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
      this.closeSandboxSockets("aborted");
    }
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

    try {
      console.log("codevil.sandbox.provision.start", {
        session_id: this.meta.session_id,
        provider: this.meta.provider,
      });
      const wsUrl = buildSandboxWebSocketUrl(this.meta.worker_url, this.meta.session_id);
      console.log("codevil.sandbox.provision.config", {
        session_id: this.meta.session_id,
        wsUrl,
        provider: this.meta.provider,
        plan_model: this.meta.plan_model,
        hasLlmKey: Boolean(this.workerEnv.CODEVIL_LLM_KEY),
      });

      await provisionSandbox({
        binding: this.workerEnv.Sandbox,
        sessionId: this.meta.session_id,
        wsUrl,
        apiKey: this.workerEnv.CODEVIL_API_KEY,
        provider: this.meta.provider,
        llmKey: this.workerEnv.CODEVIL_LLM_KEY,
      });
      console.log("codevil.sandbox.provision.started", {
        session_id: this.meta.session_id,
      });
      this.appendAndBroadcast({ type: "status", message: "Sandbox process started." });
    } catch (error) {
      console.error("codevil.sandbox.provision.failed", {
        session_id: this.meta.session_id,
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

    console.log("codevil.startPlanning", {
      session_id: this.meta.session_id,
      state: this.meta.state,
      provider: this.meta.provider,
      plan_model: this.meta.plan_model,
    });

    if (this.meta.state !== "provisioning_sandbox") {
      console.error("codevil.startPlanning.unexpected_state", {
        session_id: this.meta.session_id,
        state: this.meta.state,
        expected: "provisioning_sandbox",
      });
      this.appendAndBroadcast({
        type: "error",
        message: `Sandbox connected in unexpected state: ${this.meta.state}`,
      });
      return;
    }

    ws.send(JSON.stringify({ type: "init", repo: this.meta.repo } satisfies DOToSandboxMessage));
  }

  private handleSandboxSocketMessage(ws: WebSocket, message: string): void {
    let parsed: SandboxToDOMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    this.loadMeta();
    console.log("codevil.sandbox.message", {
      session_id: this.meta?.session_id,
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
      case "pr_created":
        if (this.transition("completed")) {
          this.appendAndBroadcast({ type: "complete", pr_url: parsed.url });
        }
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

    for (const sandbox of sandboxes) {
      sandbox.send(JSON.stringify(message));
    }
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
      ws.send(JSON.stringify({
        cursor: id,
        event: JSON.parse(eventJson),
      }));
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
