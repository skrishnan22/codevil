import { DurableObject } from "cloudflare:workers";
import type {
  SessionState,
  DOToCLIEvent,
  CLIToDOMessage,
  DOToSandboxMessage,
  SandboxToDOMessage,
  CostInfo,
  ParticipantIdentity,
  AgentRunState,
  AnnotationAnchor,
  AnnotationThread,
  AnswerableBy,
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
  buildSandboxDisconnectLogPayload,
  buildSandboxWebSocketUrl,
  mapSandboxMessageToCLIEvents,
  provisionSandbox,
  readProcessLogs,
  readSandboxDiagnostics,
  setCodevilSandboxKeepAlive,
} from "./sandbox.js";
import { createDraftPullRequest, credentialRequestAllowed } from "./github.js";
import {
  collectProviderCredentialSecrets,
  getProvisioningCredentialContext,
} from "./provider-credentials.js";
import { redactEvent } from "./redaction.js";
import {
  sanitizeDisplayName,
  sanitizeParticipantId,
  describeDecisionRejection,
  type LastDecision,
} from "./multiplayer.js";
import { canAnswerQuestion } from "./question-policy.js";
import {
  createAgentRun,
  enqueueAgentRun,
  finishActiveAgentRun,
  type AgentRun,
} from "./agent-runs.js";
import { proseBriefFromNote, toConsolidationAnnotations } from "./annotations.js";
import { activeMembershipByUserSelect, type MembershipRow } from "./memberships.js";
import {
  authorizeSocketMessage,
  socketAuthFromAttachment,
  socketAuthFromRequest,
  type SocketAuthContext,
} from "./ws-authorization.js";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  CODEVIL_API_KEY: string;
  OPENCODE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
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
  active_run?: AgentRun | null;
  queued_runs: AgentRun[];
  created_by?: ParticipantIdentity;
  preview_token_hash?: string;
  preview_url?: string;
  preview_port?: number;
  preview_active?: boolean;
  created_at: string;
  expected_close?: boolean;
  // Most recent plan decision (approve/refine), for attributing late/rejected
  // decisions to whoever already acted. See multiplayer.ts.
  last_decision?: LastDecision;
}

export interface InitOptions {
  worker_url: string;
  provider?: string;
  plan_model?: string;
  exec_model?: string;
  max_cost?: string;
  max_time?: string;
  max_steps?: number;
  created_by?: ParticipantIdentity;
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

function questionAnswerDeniedMessage(question: {
  answerable_by: AnswerableBy;
  assigned_to_name: string | null;
}): string {
  if (question.answerable_by === "assigned") {
    return question.assigned_to_name
      ? `Only ${question.assigned_to_name} can answer this question.`
      : "Only the assigned participant can answer this question.";
  }
  if (question.answerable_by === "anyone") {
    return "Only session participants can answer this question.";
  }
  return "Only the session creator can answer this question.";
}

interface SandboxProvisioningTraceOptions<T> {
  tracer: Tracer;
  secrets: readonly string[];
  attributes: Record<string, unknown>;
  provision: () => Promise<T>;
}

export async function traceSandboxProvisioning<T>(
  options: SandboxProvisioningTraceOptions<T>,
): Promise<T> {
  const { tracer, secrets, attributes, provision } = options;

  try {
    return await tracer.span(
      "sandbox.provision",
      { attributes },
      async () => {
        try {
          return await provision();
        } catch (error) {
          throw redactedProvisioningError(error, secrets);
        }
      },
    );
  } catch (error) {
    tracer.log(
      "ERROR",
      "sandbox.provision.failed",
      redactEvent(provisioningErrorAttributes(error), secrets),
    );
    throw error;
  }
}

function redactedProvisioningError(error: unknown, secrets: readonly string[]): Error {
  const attributes = redactEvent(provisioningErrorAttributes(error), secrets);
  const redacted = new Error(String(attributes.message));
  redacted.name = String(attributes.name ?? "Error");
  if (typeof attributes.stack === "string") redacted.stack = attributes.stack;

  for (const [key, value] of Object.entries(attributes)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    Object.defineProperty(redacted, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return redacted;
}

function provisioningErrorAttributes(error: unknown): Record<string, unknown> {
  const structured = typeof error === "object" && error !== null
    ? Object.fromEntries(Object.entries(error))
    : {};

  return {
    ...structured,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

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
    this.redactionSecrets = [
      env.CODEVIL_API_KEY,
      ...collectProviderCredentialSecrets(env),
      env.GITHUB_PAT,
    ].filter((secret): secret is string => Boolean(secret));
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
      CREATE TABLE IF NOT EXISTS plan_revisions (
        run_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        locked_at TEXT,
        frozen_at TEXT NOT NULL,
        PRIMARY KEY (run_id, round)
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        revision_run_id TEXT NOT NULL,
        revision_round INTEGER NOT NULL,
        anchor_json TEXT NOT NULL, -- web-highlighter HighlightSource { startMeta, endMeta, text } + { blockId, sourceLine }
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        comment TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS annotation_replies (
        id TEXT PRIMARY KEY,
        annotation_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        round INTEGER,
        question TEXT NOT NULL,
        context TEXT,
        options_json TEXT,
        answerable_by TEXT NOT NULL,
        allow_freeform INTEGER NOT NULL,
        allow_multiple INTEGER NOT NULL,
        status TEXT NOT NULL,
        answer_json TEXT,
        answered_by_id TEXT,
        answered_by_name TEXT,
        answered_at TEXT,
        assigned_to_id TEXT,
        assigned_to_name TEXT,
        cancelled_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        path        TEXT PRIMARY KEY,
        cursor      INTEGER NOT NULL,
        state_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.ensureEventPathColumn();
    this.ensureQuestionAssignmentColumns();
  }

  private ensureEventPathColumn(): void {
    // ALTER TABLE cannot use IF NOT EXISTS in SQLite; wrap in try/catch to
    // gracefully handle re-initialization on already-migrated DOs.
    try {
      this.sql.exec("ALTER TABLE events ADD COLUMN path TEXT NOT NULL DEFAULT 'session'");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) throw error;
    }
    // Index runs after the column is guaranteed to exist (either added above or pre-existing).
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_path_id ON events(path, id)"
    );
  }

  private ensureQuestionAssignmentColumns(): void {
    for (const statement of [
      "ALTER TABLE questions ADD COLUMN assigned_to_id TEXT",
      "ALTER TABLE questions ADD COLUMN assigned_to_name TEXT",
    ]) {
      try {
        this.sql.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) throw error;
      }
    }
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
      active_run: null,
      queued_runs: [],
      created_by: options.created_by,
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
      const activeRunId = this.meta.active_run?.id;
      this.transition("timed_out");
      if (activeRunId) {
        this.cancelOpenQuestions(activeRunId, "session timed out");
      }
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
      const activeRunId = this.meta.active_run?.id;
      this.transition("timed_out");
      if (activeRunId) {
        this.cancelOpenQuestions(activeRunId, "session timed out");
      }

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

    const auth = socketAuthFromRequest(request);
    const participant = this.participantFromRequest(url, auth);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["cli"]);
    server.serializeAttachment({ participant, auth });
    this.replayEvents(server, cursor);
    this.appendAndBroadcast({ type: "participant_joined", participant });

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
    this.initializeSandboxConnection(server);

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

    const participant = this.participantFromSocket(ws);
    const actor = participant.name;
    const socketAuth = this.authFromSocket(ws);
    const authz = await authorizeSocketMessage({
      auth: socketAuth,
      message: msg,
      loadMembership: (userId) => this.loadActiveMembership(userId),
    });
    if (!authz.ok) {
      ws.send(JSON.stringify({ type: "error", message: authz.message }));
      return;
    }

    switch (msg.type) {
      case "human_message":
        this.handleHumanMessage(msg.text, participant);
        break;
      case "agent_request":
        this.handleAgentRequest(msg.text, participant, msg.plan_first ?? false);
        break;
      case "annotation_create":
        this.handleAnnotationCreate(msg.run_id, msg.round, msg.anchor, msg.comment, participant);
        break;
      case "annotation_reply":
        this.handleAnnotationReply(msg.thread_id, msg.comment, participant);
        break;
      case "annotation_withdraw":
        this.handleAnnotationWithdraw(msg.thread_id, participant);
        break;
      case "question_assign":
        this.handleQuestionAssign(msg, participant, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "question_answer":
        this.handleQuestionAnswer(msg, participant, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "approve":
        this.handleApprove(actor, undefined, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "approve_run":
        this.handleApprove(actor, msg.run_id, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "abort":
        this.handleAbort(actor);
        break;
      case "abort_run":
        this.handleAbort(actor, msg.run_id);
        break;
      case "stop_session":
        await this.handleStopSession();
        break;
      case "refine_plan":
        this.handleRefine(msg.feedback, actor);
        break;
      case "refine_run":
        this.handleRefine(msg.feedback, actor, msg.run_id);
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
      if (
        !this.meta.expected_close
        && !isTerminalState(this.meta.state)
        && this.meta.state !== "awaiting_approval"
      ) {
        const activeRunId = this.meta.active_run?.id;
        const state = this.meta.state;
        const message = `Sandbox disconnected unexpectedly (code: ${code}, reason: ${reason || "none"}).`;
        this.transition("failed");
        if (activeRunId) {
          this.meta.active_run = { ...this.meta.active_run!, state: "failed" };
          this.saveMeta();
          this.cancelOpenQuestions(activeRunId, "sandbox disconnected");
          this.appendAndBroadcast({
            type: "agent_run_failed",
            run_id: activeRunId,
            message,
          });
        }
        this.appendAndBroadcast({
          type: "error",
          message,
        });
        this.updateDirectory({
          room_state: "failed",
          sandbox_state: "failed",
          active_run_state: activeRunId ? "failed" : null,
        });
        this.ctx.waitUntil(this.logSandboxDisconnectDiagnostics({
          sessionId: this.meta.session_id,
          closeCode: code,
          closeReason: reason,
          state,
        }));
      }
      return;
    }

    if (!isSandbox) {
      this.appendAndBroadcast({
        type: "participant_left",
        participant: this.participantFromSocket(ws),
      });
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

  private participantFromSocket(ws: WebSocket): ParticipantIdentity {
    const attachment = ws.deserializeAttachment() as { participant?: Partial<ParticipantIdentity> } | null;
    return {
      id: sanitizeParticipantId(attachment?.participant?.id),
      name: sanitizeDisplayName(attachment?.participant?.name),
    };
  }

  private participantFromRequest(url: URL, auth: SocketAuthContext | null): ParticipantIdentity {
    if (auth) {
      return {
        id: sanitizeParticipantId(auth.userId),
        name: sanitizeDisplayName(auth.name || auth.email),
      };
    }

    return {
      id: sanitizeParticipantId(url.searchParams.get("participant_id")),
      name: sanitizeDisplayName(url.searchParams.get("name")),
    };
  }

  private authFromSocket(ws: WebSocket): SocketAuthContext | null {
    return socketAuthFromAttachment(ws.deserializeAttachment() as { auth?: Partial<SocketAuthContext> } | null);
  }

  private async loadActiveMembership(userId: string): Promise<MembershipRow | null> {
    const select = activeMembershipByUserSelect(userId);
    return await this.workerEnv.DB.prepare(select.sql).bind(...select.bindings).first<MembershipRow>();
  }

  private handleApprove(
    actor: string,
    runId?: string,
    userId?: string | null,
    role?: MembershipRow["role"] | null,
  ): void {
    if (!this.meta) return;

    if (!this.ensureActiveRun(runId)) return;

    if (this.meta.state !== "awaiting_approval") {
      this.appendAndBroadcast(this.decisionRejection("approve", `Cannot approve in state: ${this.meta.state}`));
      return;
    }

    if (this.transition("executing")) {
      this.setActiveRunState("executing");
      this.recordDecision({ actor, action: "approve", refinement_round: this.meta.refinement_round });
      this.appendAndBroadcast({
        type: "status",
        message: "Plan approved. Starting execution.",
        actor,
      });
      this.sendToSandbox({
        type: "execute",
        plan: this.meta.latest_plan ?? "",
        model: this.meta.exec_model,
        provider: this.meta.provider,
      });
    }
  }

  private handleAskQuestionRequest(
    msg: Extract<SandboxToDOMessage, { type: "ask_question_request" }>,
  ): void {
    if (!this.meta) return;
    const now = new Date().toISOString();
    const round = this.meta.refinement_round ?? null;

    this.sql.exec(
      `INSERT OR REPLACE INTO questions (
        request_id, run_id, round, question, context, options_json,
        answerable_by, allow_freeform, allow_multiple, status,
        answer_json, answered_by_id, answered_by_name, answered_at,
        assigned_to_id, assigned_to_name, cancelled_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
      msg.request_id,
      msg.run_id,
      round,
      msg.question,
      msg.context ?? null,
      msg.options ? JSON.stringify(msg.options) : null,
      msg.answerable_by,
      msg.allow_freeform ? 1 : 0,
      msg.allow_multiple ? 1 : 0,
      msg.assigned_to?.id ?? null,
      msg.assigned_to?.name ?? null,
      now,
    );

    this.appendAndBroadcast({
      type: "question_raised",
      request_id: msg.request_id,
      run_id: msg.run_id,
      question: msg.question,
      ...(msg.context !== undefined ? { context: msg.context } : {}),
      ...(msg.options !== undefined ? { options: msg.options } : {}),
      allow_freeform: msg.allow_freeform,
      allow_multiple: msg.allow_multiple,
      answerable_by: msg.answerable_by,
      ...(msg.assigned_to !== undefined ? { assigned_to: msg.assigned_to } : {}),
      status: "open",
      raised_at: now,
    });
  }

  private handleQuestionAssign(
    msg: Extract<CLIToDOMessage, { type: "question_assign" }>,
    actor: ParticipantIdentity,
    userId: string | null,
    role: MembershipRow["role"] | null,
  ): void {
    if (!this.meta) return;

    const question = this.loadQuestion(msg.request_id);
    if (!question || question.status !== "open") {
      this.appendAndBroadcast({ type: "error", message: "Question not found or already answered." });
      return;
    }

    if (!canAnswerQuestion("decider", userId, this.meta.created_by?.id, role)) {
      this.appendAndBroadcast({ type: "error", message: "Only the session creator can assign this question." });
      return;
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE questions
       SET answerable_by = 'assigned', assigned_to_id = ?, assigned_to_name = ?
       WHERE request_id = ?`,
      msg.assigned_to.id,
      msg.assigned_to.name,
      msg.request_id,
    );

    this.appendAndBroadcast({
      type: "question_assigned",
      request_id: msg.request_id,
      assigned_to: msg.assigned_to,
      assigned_by: actor,
      assigned_at: now,
    });
  }

  private handleQuestionAnswer(
    msg: Extract<CLIToDOMessage, { type: "question_answer" }>,
    actor: ParticipantIdentity,
    userId: string | null,
    role: MembershipRow["role"] | null,
  ): void {
    if (!this.meta) return;

    const question = this.loadQuestion(msg.request_id);
    if (!question || question.status !== "open") {
      this.appendAndBroadcast({ type: "error", message: "Question not found or already answered." });
      return;
    }

    if (!canAnswerQuestion(question.answerable_by, userId, this.meta.created_by?.id, role, question.assigned_to_id)) {
      this.appendAndBroadcast({ type: "error", message: questionAnswerDeniedMessage(question) });
      return;
    }

    const now = new Date().toISOString();
    const optionIds = msg.option_ids ?? [];
    const answerJson = JSON.stringify({ option_ids: optionIds, freeform: msg.freeform });

    this.sql.exec(
      `UPDATE questions
       SET status = 'answered', answer_json = ?, answered_by_id = ?, answered_by_name = ?, answered_at = ?
       WHERE request_id = ?`,
      answerJson,
      actor.id,
      actor.name,
      now,
      msg.request_id,
    );

    this.appendAndBroadcast({
      type: "question_answered",
      request_id: msg.request_id,
      option_ids: optionIds,
      ...(msg.freeform !== undefined ? { freeform: msg.freeform } : {}),
      answered_by: actor,
      answered_at: now,
    });

    this.sendToSandbox({
      type: "ask_question_response",
      request_id: msg.request_id,
      option_ids: optionIds,
      ...(msg.freeform !== undefined ? { freeform: msg.freeform } : {}),
      answered_by: actor,
    });
  }

  private cancelOpenQuestions(runId: string, reason: string): void {
    const openQuestions: { request_id: string }[] = [];
    for (const row of this.sql.exec(
      `SELECT request_id FROM questions WHERE run_id = ? AND status = 'open'`,
      runId,
    )) {
      openQuestions.push({ request_id: row["request_id"] as string });
    }

    if (openQuestions.length === 0) return;

    this.sql.exec(
      `UPDATE questions SET status = 'cancelled', cancelled_reason = ? WHERE run_id = ? AND status = 'open'`,
      reason,
      runId,
    );

    for (const { request_id } of openQuestions) {
      this.sendToSandbox({ type: "ask_question_cancelled", request_id, reason });
    }
  }

  private loadQuestion(requestId: string): {
    run_id: string;
    status: string;
    answerable_by: AnswerableBy;
    assigned_to_id: string | null;
    assigned_to_name: string | null;
  } | null {
    for (const row of this.sql.exec(
      `SELECT run_id, status, answerable_by, assigned_to_id, assigned_to_name
       FROM questions
       WHERE request_id = ?`,
      requestId,
    )) {
      return {
        run_id: row["run_id"] as string,
        status: row["status"] as string,
        answerable_by: row["answerable_by"] as AnswerableBy,
        assigned_to_id: (row["assigned_to_id"] as string | null) ?? null,
        assigned_to_name: (row["assigned_to_name"] as string | null) ?? null,
      };
    }
    return null;
  }

  private handleHumanMessage(text: string, actor: ParticipantIdentity): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.appendAndBroadcast({
      type: "human_message",
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      actor,
      text: trimmed,
      created_at: new Date().toISOString(),
    });
    this.updateDirectory({});
  }

  private handleAgentRequest(text: string, actor: ParticipantIdentity, planFirst: boolean): void {
    if (!this.meta) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const run = createAgentRun({
      actor,
      text: trimmed,
      now: new Date().toISOString(),
      planFirst,
    });

    this.appendAndBroadcast({
      type: "agent_request",
      run_id: run.id,
      actor,
      text: run.text,
      created_at: run.created_at,
    });

    if (!this.meta.active_run && this.meta.state !== "ready") {
      this.meta.queued_runs = [...this.meta.queued_runs, run];
      this.saveMeta();
      this.appendAndBroadcast({
        type: "agent_request_queued",
        run_id: run.id,
        position: this.meta.queued_runs.length,
      });
      this.updateDirectory({});
      return;
    }

    const next = enqueueAgentRun({
      active: this.meta.active_run ?? null,
      queue: this.meta.queued_runs,
    }, run);

    this.meta.active_run = next.active;
    this.meta.queued_runs = next.queue;
    this.saveMeta();

    if (next.queued) {
      this.appendAndBroadcast({
        type: "agent_request_queued",
        run_id: next.queued.run.id,
        position: next.queued.position,
      });
      this.updateDirectory({});
      return;
    }

    if (next.started) {
      this.startAgentRun(next.started);
    }
  }

  private handleAnnotationCreate(
    runId: string,
    round: number,
    anchor: AnnotationAnchor,
    comment: string,
    actor: ParticipantIdentity,
  ): void {
    if (!this.ensureAnnotatableRevision(runId, round)) return;

    const now = new Date().toISOString();
    const annotation: AnnotationThread = {
      id: `ann_${crypto.randomUUID().replace(/-/g, "")}`,
      run_id: runId,
      round,
      anchor,
      author: actor,
      comment: comment.trim(),
      status: "open",
      created_at: now,
    };

    this.sql.exec(
      `INSERT INTO annotations (
        id, revision_run_id, revision_round, anchor_json, author_id,
        author_name, comment, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      annotation.id,
      runId,
      round,
      JSON.stringify(anchor),
      actor.id,
      actor.name,
      annotation.comment,
      annotation.status,
      now,
    );

    this.appendAndBroadcast({ type: "annotation_created", annotation });
  }

  private handleAnnotationReply(threadId: string, comment: string, actor: ParticipantIdentity): void {
    const annotation = this.loadAnnotation(threadId);
    if (!annotation) {
      this.appendAndBroadcast({ type: "error", message: "Annotation not found." });
      return;
    }
    if (!this.ensureAnnotatableRevision(annotation.revision_run_id, annotation.revision_round)) return;
    if (annotation.status !== "open") {
      this.appendAndBroadcast({ type: "error", message: "Cannot reply to a closed annotation." });
      return;
    }

    const now = new Date().toISOString();
    const reply = {
      id: `rep_${crypto.randomUUID().replace(/-/g, "")}`,
      author: actor,
      comment: comment.trim(),
      created_at: now,
    };

    this.sql.exec(
      `INSERT INTO annotation_replies (
        id, annotation_id, author_id, author_name, body, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      reply.id,
      threadId,
      actor.id,
      actor.name,
      reply.comment,
      now,
    );

    this.appendAndBroadcast({ type: "annotation_replied", thread_id: threadId, reply });
  }

  private handleAnnotationWithdraw(threadId: string, actor: ParticipantIdentity): void {
    const annotation = this.loadAnnotation(threadId);
    if (!annotation) {
      this.appendAndBroadcast({ type: "error", message: "Annotation not found." });
      return;
    }
    if (!this.ensureAnnotatableRevision(annotation.revision_run_id, annotation.revision_round)) return;
    if (annotation.status !== "open") {
      this.appendAndBroadcast({ type: "error", message: "Cannot withdraw a closed annotation." });
      return;
    }
    if (annotation.author_id !== actor.id) {
      this.appendAndBroadcast({ type: "error", message: "Only the annotation author can withdraw it." });
      return;
    }

    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE annotations SET status = 'withdrawn' WHERE id = ?",
      threadId,
    );
    this.appendAndBroadcast({
      type: "annotation_withdrawn",
      thread_id: threadId,
      withdrawn_by: actor,
      withdrawn_at: now,
    });
  }

  // Abort is an always-available kill switch, not a plan decision — it is
  // deliberately NOT gated by first-action-wins (so aborting during execution
  // is valid, not a "lost race").
  private handleAbort(actor: string, runId?: string): void {
    if (!this.meta) return;

    if (!this.ensureActiveRun(runId)) return;

    if (isTerminalState(this.meta.state)) {
      this.appendAndBroadcast({
        type: "error",
        message: `Session already in terminal state: ${this.meta.state}`,
      });
      return;
    }

    const activeRunId = this.meta.active_run?.id;
    if (this.transition("ready")) {
      this.appendAndBroadcast({
        type: "status",
        message: "Agent run cancelled.",
        actor,
      });
      if (activeRunId) {
        this.cancelOpenQuestions(activeRunId, "run cancelled");
        this.appendAndBroadcast({
          type: "agent_run_failed",
          run_id: activeRunId,
          message: "Agent run cancelled.",
        });
      }
      this.finishRunAndDrainQueue("cancelled");
      // Preview stays alive; user can keep iterating in the iframe until they
      // press "Stop Session" or the container hits idle/max timeout.
    }
  }

  private async handleStopSession(): Promise<void> {
    if (!this.meta) return;
    if (!isTerminalState(this.meta.state)) {
      this.transition("failed");
    }
    const activeRunId = this.meta.active_run?.id;
    if (activeRunId) {
      this.cancelOpenQuestions(activeRunId, "session stopped");
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
      await setCodevilSandboxKeepAlive(sandbox, false, reason);
      await sandbox.stop();
    } catch (error) {
      this.getTracer()?.log("ERROR", "sandbox.stop.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.closeSandboxSockets(reason);
  }

  private handleRefine(feedback: string, actor: string, runId?: string): void {
    if (!this.meta) return;

    if (!this.ensureActiveRun(runId)) return;

    if (this.meta.state !== "awaiting_approval") {
      this.appendAndBroadcast(this.decisionRejection("refine", `Cannot refine in state: ${this.meta.state}`));
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
      this.setActiveRunState("thinking");
      // Record the decision against the round being refined (before the
      // increment) so a same-round rejection can be attributed correctly.
      this.recordDecision({ actor, action: "refine", refinement_round: this.meta.refinement_round });
      this.appendAndBroadcast({
        type: "status",
        message: `Refining plan (round ${this.meta.refinement_round + 1}/${MAX_REFINEMENT_ROUNDS}): ${feedback}`,
        actor,
      });

      if (this.meta.active_run?.plan_first) {
        this.startPlanFirstRefinement(feedback);
        return;
      }

      this.dispatchProseBrief(feedback);
    }
  }

  private startPlanFirstRefinement(feedback: string): void {
    if (!this.meta?.active_run) return;

    const runId = this.meta.active_run.id;
    const round = this.meta.refinement_round;
    const revision = this.loadFullPlanRevision(runId, round);
    if (!revision) {
      this.transition("awaiting_approval");
      this.setActiveRunState("awaiting_approval");
      this.appendAndBroadcast({ type: "error", message: "Plan revision not found." });
      return;
    }

    this.lockPlanRevision(runId, round);
    const threads = this.loadOpenAnnotationThreads(runId, round);

    if (threads.length <= 1) {
      this.dispatchProseBrief(proseBriefFromNote(feedback, threads));
      return;
    }

    const requestId = `con_${crypto.randomUUID().replace(/-/g, "")}`;
    this.appendAndBroadcast({
      type: "consolidation_started",
      run_id: runId,
      round,
    });
    this.sendToSandbox({
      type: "consolidate_annotations",
      run_id: runId,
      round,
      plan_revision_id: `${runId}:${round}`,
      plan: revision.markdown,
      annotations: toConsolidationAnnotations(threads),
      model: this.meta.plan_model,
      provider: this.meta.provider,
    });
    this.getTracer()?.log("INFO", "consolidation.requested", { request_id: requestId, run_id: runId, round });
  }

  private ensureActiveRun(runId?: string): boolean {
    if (!this.meta) return false;
    const active = this.meta.active_run;
    if (!active) {
      this.appendAndBroadcast({ type: "error", message: "No active agent run." });
      return false;
    }
    if (runId && active.id !== runId) {
      this.appendAndBroadcast({
        type: "error",
        message: `Run ${runId} is not active.`,
      });
      return false;
    }
    return true;
  }

  private startAgentRun(run: AgentRun): void {
    if (!this.meta) return;

    this.meta.active_run = run;
    this.meta.prompt = run.text;
    this.meta.latest_plan = undefined;
    this.meta.refinement_round = 0;
    this.meta.verification_attempts = 0;
    this.meta.last_decision = undefined;
    this.saveMeta();

    if (this.meta.state !== "ready") {
      this.appendAndBroadcast({
        type: "agent_run_failed",
        run_id: run.id,
        message: `Cannot start agent run in state: ${this.meta.state}`,
      });
      this.finishRunAndDrainQueue("failed");
      return;
    }

    if (run.plan_first) {
      if (!this.transition("planning")) {
        this.failActiveRunAndReturnReady(`Cannot start agent run in state: ${this.meta.state}`);
        return;
      }

      this.setActiveRunState("thinking");
      this.appendAndBroadcast({
        type: "agent_run_started",
        run_id: run.id,
        actor: run.actor,
        text: run.text,
      });
      this.appendAndBroadcast({
        type: "phase",
        phase: "planning",
        model: this.meta.plan_model,
      });
      this.sendToSandbox({
        type: "plan",
        run_id: run.id,
        prompt: run.text,
        model: this.meta.plan_model,
        provider: this.meta.provider,
      });
      return;
    }

    if (!this.transition("executing")) {
      this.failActiveRunAndReturnReady(`Cannot start agent run in state: ${this.meta.state}`);
      return;
    }

    this.setActiveRunState("executing");
    this.appendAndBroadcast({
      type: "agent_run_started",
      run_id: run.id,
      actor: run.actor,
      text: run.text,
    });
    this.appendAndBroadcast({
      type: "phase",
      phase: "executing",
      model: this.meta.exec_model,
    });
    this.sendToSandbox({
      type: "agent_turn",
      run_id: run.id,
      prompt: run.text,
      model: this.meta.exec_model,
      provider: this.meta.provider,
    });
  }

  private setActiveRunState(state: AgentRunState): void {
    if (!this.meta?.active_run) return;
    this.meta.active_run = { ...this.meta.active_run, state };
    this.saveMeta();
    this.updateDirectory({ active_run_state: state });
  }

  private finishRunAndDrainQueue(finalState: AgentRunState): void {
    if (!this.meta) return;
    if (this.meta.active_run) {
      this.meta.active_run = { ...this.meta.active_run, state: finalState };
    }
    const next = finishActiveAgentRun({
      active: this.meta.active_run ?? null,
      queue: this.meta.queued_runs,
    });
    this.meta.active_run = next.active;
    this.meta.queued_runs = next.queue;
    this.saveMeta();
    this.updateDirectory({ active_run_state: next.active?.state ?? null });

    if (next.started) {
      this.startAgentRun(next.started);
    }
  }

  private failActiveRunAndReturnReady(message: string): void {
    if (!this.meta?.active_run) return;
    const runId = this.meta.active_run.id;
    this.appendAndBroadcast({
      type: "agent_run_failed",
      run_id: runId,
      message,
    });
    if (this.meta.state !== "ready" && isValidTransition(this.meta.state, "ready")) {
      this.transition("ready");
    }
    this.finishRunAndDrainQueue("failed");
  }

  private completeActiveRun(prUrl?: string): void {
    if (!this.meta?.active_run) return;
    const runId = this.meta.active_run.id;

    if (this.meta.state !== "ready" && isValidTransition(this.meta.state, "ready")) {
      this.transition("ready");
    }
    this.appendAndBroadcast({
      type: "agent_run_completed",
      run_id: runId,
      ...(prUrl ? { pr_url: prUrl } : {}),
    });
    this.finishRunAndDrainQueue("completed");
  }

  // Persist the most recent plan decision so a later, rejected decision can name
  // whoever already acted on this plan.
  private recordDecision(decision: LastDecision): void {
    if (!this.meta) return;
    this.meta.last_decision = decision;
    this.saveMeta();
  }

  // Build an attributed rejection event for a too-late plan decision, falling
  // back to the generic state-only message when no same-round decider is known.
  private decisionRejection(
    attemptedAction: "approve" | "refine",
    fallbackMessage: string,
  ): { type: "error"; message: string; actor?: string } {
    const attribution = this.meta
      ? describeDecisionRejection(attemptedAction, this.meta.last_decision ?? null, this.meta.refinement_round)
      : null;
    if (attribution) {
      return { type: "error", message: attribution.message, actor: attribution.actor };
    }
    return { type: "error", message: fallbackMessage };
  }

  private async provisionSessionSandbox(): Promise<void> {
    this.loadMeta();
    if (!this.meta) return;

    if (!this.transition("provisioning_sandbox")) return;
    this.updateDirectory({ sandbox_state: "provisioning" });

    const tracer = this.getTracer();
    try {
      const wsUrl = buildSandboxWebSocketUrl(this.meta.worker_url, this.meta.session_id);
      const provisioningContext = getProvisioningCredentialContext(this.workerEnv, this.meta.provider);
      await traceSandboxProvisioning({
        tracer: tracer!,
        secrets: this.redactionSecrets,
        attributes: {
          provider: this.meta.provider,
          plan_model: this.meta.plan_model,
          has_llm_key: provisioningContext.hasLlmKey,
        },
        provision: () =>
          provisionSandbox({
            binding: this.workerEnv.Sandbox,
            sessionId: this.meta!.session_id,
            wsUrl,
            apiKey: this.workerEnv.CODEVIL_API_KEY,
            provider: this.meta!.provider,
            llmKey: provisioningContext.llmKey,
          }),
      });
      this.appendAndBroadcast({ type: "status", message: "Sandbox process started." });
    } catch (error) {
      this.transition("failed");
      this.appendAndBroadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private initializeSandboxConnection(ws: WebSocket): void {
    this.loadMeta();
    if (!this.meta) {
      console.error("codevil.initializeSandboxConnection.no_meta");
      return;
    }

    const tracer = this.getTracer();
    tracer?.log("INFO", "start_sandbox_init", {
      state: this.meta.state,
      provider: this.meta.provider,
      plan_model: this.meta.plan_model,
    });

    if (this.meta.state !== "provisioning_sandbox") {
      tracer?.log("ERROR", "sandbox_init.unexpected_state", {
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
      case "agent_turn_complete":
        this.handleSandboxAgentTurnComplete(parsed.run_id, parsed.response, parsed.cost);
        return;
      case "create_pr_request":
        await this.handleCreatePullRequestRequest(ws, parsed);
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
      case "consolidation_complete":
        this.handleConsolidationComplete(parsed.run_id, parsed.round, parsed.brief, parsed.cost);
        return;
      case "consolidation_failed":
        this.handleConsolidationFailed(parsed.run_id, parsed.round, parsed.message);
        return;
      case "verification_failed":
        this.handleSandboxVerificationFailed(parsed.attempts, parsed.last_error);
        return;
      case "ask_question_request":
        this.handleAskQuestionRequest(parsed);
        return;
      case "credential_request":
        this.handleCredentialRequest(ws, parsed);
        return;
      case "branch_pushed":
        await this.handleBranchPushed(parsed.branch, parsed.base_branch, parsed.pr_title, parsed.pr_body);
        return;
      case "pr_created":
        this.completeActiveRun(parsed.url);
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
        if (this.meta.active_run && this.meta.state === "executing") {
          this.cancelOpenQuestions(this.meta.active_run.id, "run failed");
          this.failActiveRunAndReturnReady(parsed.message);
        } else {
          const activeRunId = this.meta.active_run?.id;
          this.transition("failed");
          if (activeRunId) {
            this.cancelOpenQuestions(activeRunId, "session failed");
          }
          this.appendAndBroadcast({ type: "error", message: parsed.message });
        }
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
    if (this.transition("cloning_repo")) {
      this.updateDirectory({ sandbox_state: "cloning" });
    }
  }

  private handleSandboxCloneComplete(): void {
    if (!this.meta) return;
    if (this.meta.state !== "cloning_repo") return;

    if (this.transition("ready")) {
      this.updateDirectory({ room_state: "ready", sandbox_state: "ready" });
      this.appendAndBroadcast({ type: "status", message: "Repository cloned. Room is ready." });
      this.appendAndBroadcast({ type: "room_ready", repo: this.meta.repo });
      if (!this.meta.active_run && this.meta.queued_runs.length > 0) {
        this.finishRunAndDrainQueue("completed");
      }
    }
  }

  private handleSandboxPlanReady(plan: string, cost: CostInfo): void {
    if (!this.meta) return;

    this.meta.latest_plan = plan;
    this.saveMeta();

    if (!this.recordCost(cost)) return;

    if (this.meta.state === "planning") {
      if (this.meta.active_run?.plan_first) {
        this.freezePlanRevision(this.meta.active_run.id, this.meta.refinement_round, plan);
      }
      if (this.transition("awaiting_approval")) {
        this.setActiveRunState("awaiting_approval");
        this.appendAndBroadcast({
          type: "approval_requested",
          run_id: this.meta.active_run?.id ?? "run_unknown",
          plan,
          cost,
          refinement_round: this.meta.refinement_round,
        });
        this.appendAndBroadcast({ type: "status", message: "Waiting for user approval." });
      }
      return;
    }

    if (this.meta.state === "refining") {
      if (this.meta.active_run?.plan_first) {
        this.freezePlanRevision(this.meta.active_run.id, this.meta.refinement_round, plan);
      }
      if (this.transition("awaiting_approval")) {
        this.setActiveRunState("awaiting_approval");
        this.appendAndBroadcast({
          type: "approval_requested",
          run_id: this.meta.active_run?.id ?? "run_unknown",
          plan,
          cost,
          refinement_round: this.meta.refinement_round,
        });
        this.appendAndBroadcast({ type: "status", message: "Waiting for user approval." });
      }
    }
  }

  private handleConsolidationComplete(
    runId: string,
    round: number,
    brief: string,
    cost: CostInfo,
  ): void {
    if (!this.meta?.active_run || this.meta.state !== "refining") return;
    if (this.meta.active_run.id !== runId || this.meta.refinement_round !== round) return;
    if (!this.recordCost(cost)) return;

    // The consolidation agent resolved any contradictions inline via ask_question
    // and returned a plain-prose brief.
    this.dispatchProseBrief(brief);
  }

  private dispatchProseBrief(brief: string): void {
    if (!this.meta?.active_run) return;
    const fromRound = this.meta.refinement_round;
    const toRound = fromRound + 1;

    this.meta.refinement_round = toRound;
    this.saveMeta();
    this.appendAndBroadcast({
      type: "brief_dispatched",
      run_id: this.meta.active_run.id,
      from_round: fromRound,
      to_round: toRound,
      brief,
    });
    this.sendToSandbox({
      type: "refine_plan",
      feedback: brief.trim().length > 0 ? brief : "Refine the plan.",
    });
  }

  private handleConsolidationFailed(runId: string, round: number, message: string): void {
    if (!this.meta?.active_run || this.meta.state !== "refining") return;
    if (this.meta.active_run.id !== runId || this.meta.refinement_round !== round) return;

    if (this.transition("awaiting_approval")) {
      this.setActiveRunState("awaiting_approval");
      this.appendAndBroadcast({ type: "error", message });
    }
  }

  private handleSandboxAgentTurnComplete(runId: string, response: string, cost: CostInfo): void {
    if (!this.meta?.active_run || this.meta.state !== "executing") return;
    if (this.meta.active_run.id !== runId) return;
    if (!this.recordCost(cost)) return;

    this.appendAndBroadcast({
      type: "agent_response",
      run_id: this.meta.active_run.id,
      text: response,
    });
    this.completeActiveRun();
  }

  private handleSandboxVerificationStarted(attempt: number, maxAttempts: number): void {
    if (!this.meta) return;
    if (this.meta.state === "executing" || this.meta.state === "retrying") {
      this.meta.verification_attempts = attempt;
      this.saveMeta();
      if (this.transition("verifying")) {
        this.setActiveRunState("verifying");
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
      this.setActiveRunState("executing");
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
      this.setActiveRunState("publishing");
      this.appendAndBroadcast({ type: "status", message: "Execution completed. Creating pull request." });
      const runPrompt = this.meta.active_run?.text ?? this.meta.prompt;
      this.sendToSandbox({
        type: "create_pr",
        branch: `codevil/${slugify(runPrompt)}-${Date.now()}`,
        commit_message: `Implement ${runPrompt}`,
        pr_title: runPrompt,
        pr_body: this.meta.latest_plan ?? runPrompt,
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

  private async handleCreatePullRequestRequest(
    ws: WebSocket,
    request: Extract<SandboxToDOMessage, { type: "create_pr_request" }>,
  ): Promise<void> {
    if (!this.meta) return;

    try {
      if (this.meta.state !== "executing" || this.meta.active_run?.id !== request.run_id) {
        throw new Error(`Agent run ${request.run_id} is no longer active.`);
      }
      if (!this.workerEnv.GITHUB_PAT) throw new Error("GitHub credentials are not configured.");
      const url = await createDraftPullRequest({
        repo: this.meta.repo,
        token: this.workerEnv.GITHUB_PAT,
        branch: request.branch,
        baseBranch: request.base_branch,
        title: request.title,
        body: request.body,
        draft: request.draft,
      });
      ws.send(JSON.stringify({
        type: "create_pr_response",
        request_id: request.request_id,
        url,
      } satisfies DOToSandboxMessage));
    } catch (error) {
      ws.send(JSON.stringify({
        type: "create_pr_response",
        request_id: request.request_id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies DOToSandboxMessage));
    }
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

      this.completeActiveRun(prUrl);
    } catch (error) {
      this.failActiveRunAndReturnReady(error instanceof Error ? error.message : String(error));
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
      this.failActiveRunAndReturnReady(lastError);
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
      message.type !== "agent_turn" &&
      message.type !== "execute" &&
      message.type !== "refine_plan" &&
      message.type !== "create_pr" &&
      message.type !== "preview_start" &&
      message.type !== "consolidate_annotations"
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

  private async logSandboxDisconnectDiagnostics(options: {
    sessionId: string;
    closeCode: number;
    closeReason: string;
    state: SessionState;
  }): Promise<void> {
    try {
      const diagnostics = await readSandboxDiagnostics(this.workerEnv.Sandbox, options.sessionId, "codevil-agent");
      const payload = buildSandboxDisconnectLogPayload({
        sessionId: options.sessionId,
        closeCode: options.closeCode,
        closeReason: options.closeReason,
        state: options.state,
        diagnostics,
      });
      this.getTracer()?.log(
        "ERROR",
        "sandbox.disconnect_diagnostics",
        redactEvent(payload, this.redactionSecrets) as unknown as Record<string, unknown>,
      );
    } catch (error) {
      this.getTracer()?.log("ERROR", "sandbox.disconnect_diagnostics.failed", {
        session_id: options.sessionId,
        close_code: options.closeCode,
        close_reason: options.closeReason || "none",
        state: options.state,
        error: error instanceof Error ? error.message : String(error),
      });
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
      { state: "ready", event: { type: "room_ready", repo: this.meta.repo } },
      { state: "executing", event: { type: "phase", phase: "executing", model: "claude-sonnet-4-6" } },
      { state: "ready", event: { type: "agent_response", run_id: "run_test", text: "The repository is ready. Ask me a question or request a code change." } },
    ];

    for (const step of steps) {
      if (this.transition(step.state)) {
        this.appendAndBroadcast(step.event);
      }
    }
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

  private updateDirectory(patch: {
    room_state?: string;
    sandbox_state?: string;
    active_run_state?: string | null;
  }): void {
    this.loadMeta();
    if (!this.meta) return;

    const now = new Date().toISOString();
    const entries: [string, unknown][] = [
      ["updated_at", now],
      ["last_event_at", now],
    ];
    if (patch.room_state !== undefined) entries.push(["room_state", patch.room_state]);
    if (patch.sandbox_state !== undefined) entries.push(["sandbox_state", patch.sandbox_state]);
    if (patch.active_run_state !== undefined) entries.push(["active_run_state", patch.active_run_state]);

    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const bindings = [...entries.map(([, value]) => value), this.meta.session_id];

    this.ctx.waitUntil(
      this.workerEnv.DB
        .prepare(`UPDATE sessions SET ${assignments} WHERE id = ?`)
        .bind(...bindings)
        .run()
        .catch((error) => {
          this.getTracer()?.log("ERROR", "session_directory.update.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  }

  private freezePlanRevision(runId: string, round: number, markdown: string): void {
    const now = new Date().toISOString();
    if (round > 0) {
      this.consumeOpenAnnotations(runId, round - 1);
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO plan_revisions (
        run_id, round, markdown, locked_at, frozen_at
      ) VALUES (?, ?, ?, NULL, ?)`,
      runId,
      round,
      markdown,
      now,
    );
    this.appendAndBroadcast({
      type: "plan_revision_frozen",
      run_id: runId,
      round,
      markdown,
      locked: false,
      created_at: now,
    });
  }

  private lockPlanRevision(runId: string, round: number): void {
    const lockedAt = new Date().toISOString();
    this.sql.exec(
      `UPDATE plan_revisions
       SET locked_at = COALESCE(locked_at, ?)
       WHERE run_id = ? AND round = ?`,
      lockedAt,
      runId,
      round,
    );
    this.appendAndBroadcast({
      type: "plan_revision_frozen",
      run_id: runId,
      round,
      locked: true,
      created_at: lockedAt,
    });
  }

  private consumeOpenAnnotations(runId: string, round: number): void {
    const ids = this.loadOpenAnnotationThreads(runId, round).map((thread) => thread.id);
    if (ids.length === 0) return;

    this.sql.exec(
      "UPDATE annotations SET status = 'consumed' WHERE revision_run_id = ? AND revision_round = ? AND status = 'open'",
      runId,
      round,
    );
    this.appendAndBroadcast({
      type: "annotations_consumed",
      run_id: runId,
      round,
      thread_ids: ids,
    });
  }

  private ensureAnnotatableRevision(runId: string, round: number): boolean {
    if (!this.meta) return false;
    if (!this.meta.active_run?.plan_first) {
      this.appendAndBroadcast({ type: "error", message: "Annotations are only available on plan-first runs." });
      return false;
    }
    if (this.meta.state !== "awaiting_approval") {
      this.appendAndBroadcast({ type: "error", message: `Cannot annotate in state: ${this.meta.state}` });
      return false;
    }
    if (this.meta.active_run.id !== runId || this.meta.refinement_round !== round) {
      this.appendAndBroadcast({ type: "error", message: "Annotation target is not the active plan revision." });
      return false;
    }

    const revision = this.loadPlanRevision(runId, round);
    if (!revision) {
      this.appendAndBroadcast({ type: "error", message: "Plan revision not found." });
      return false;
    }
    if (revision.locked_at) {
      this.appendAndBroadcast({ type: "error", message: "Plan revision is locked." });
      return false;
    }

    return true;
  }

  private loadPlanRevision(runId: string, round: number): { locked_at: string | null } | null {
    for (const row of this.sql.exec(
      "SELECT locked_at FROM plan_revisions WHERE run_id = ? AND round = ?",
      runId,
      round,
    )) {
      return { locked_at: row["locked_at"] as string | null };
    }
    return null;
  }

  private loadFullPlanRevision(runId: string, round: number): { markdown: string; locked_at: string | null } | null {
    for (const row of this.sql.exec(
      "SELECT markdown, locked_at FROM plan_revisions WHERE run_id = ? AND round = ?",
      runId,
      round,
    )) {
      return {
        markdown: row["markdown"] as string,
        locked_at: row["locked_at"] as string | null,
      };
    }
    return null;
  }

  private loadOpenAnnotationThreads(runId: string, round: number): AnnotationThread[] {
    const threads: AnnotationThread[] = [];
    for (const row of this.sql.exec(
      `SELECT id, anchor_json, author_id, author_name, comment, status, created_at
       FROM annotations
       WHERE revision_run_id = ? AND revision_round = ? AND status = 'open'
       ORDER BY created_at ASC`,
      runId,
      round,
    )) {
      const id = row["id"] as string;
      threads.push({
        id,
        run_id: runId,
        round,
        anchor: JSON.parse(row["anchor_json"] as string) as AnnotationAnchor,
        author: {
          id: row["author_id"] as string,
          name: row["author_name"] as string,
        },
        comment: row["comment"] as string,
        status: row["status"] as "open",
        created_at: row["created_at"] as string,
        replies: this.loadAnnotationReplies(id),
      });
    }
    return threads;
  }

  private loadAnnotationReplies(annotationId: string): NonNullable<AnnotationThread["replies"]> {
    const replies: NonNullable<AnnotationThread["replies"]> = [];
    for (const row of this.sql.exec(
      `SELECT id, author_id, author_name, body, created_at
       FROM annotation_replies
       WHERE annotation_id = ?
       ORDER BY created_at ASC`,
      annotationId,
    )) {
      replies.push({
        id: row["id"] as string,
        author: {
          id: row["author_id"] as string,
          name: row["author_name"] as string,
        },
        comment: row["body"] as string,
        created_at: row["created_at"] as string,
      });
    }
    return replies;
  }

  private loadAnnotation(id: string): {
    revision_run_id: string;
    revision_round: number;
    author_id: string;
    status: string;
  } | null {
    for (const row of this.sql.exec(
      `SELECT revision_run_id, revision_round, author_id, status
       FROM annotations
       WHERE id = ?`,
      id,
    )) {
      return {
        revision_run_id: row["revision_run_id"] as string,
        revision_round: row["revision_round"] as number,
        author_id: row["author_id"] as string,
        status: row["status"] as string,
      };
    }
    return null;
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
      this.meta!.queued_runs ??= [];
      this.meta!.active_run ??= null;
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
