import { DurableObject } from "cloudflare:workers";
import type {
  SessionState,
  DOToCLIEvent,
  DOToSandboxMessage,
  CostInfo,
  ParticipantIdentity,
  AgentRunState,
} from "@codevil/shared";
import {
  DEFAULT_CONFIG,
  isValidTransition,
  isTerminalState,
  CLIToDOMessageSchema,
  clientValidationErrorMessage,
  parseInbound,
  createTracer,
  safeExceptionAttributes,
  setValidationDropSink,
  tracerValidationDropSink,
  type Span,
  type Tracer,
} from "@codevil/shared";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  buildSandboxDisconnectLogPayload,
  readProcessLogs,
  readSandboxDiagnostics,
  setCodevilSandboxKeepAlive,
} from "./sandbox.js";
import {
  SANDBOX_RECONNECT_GRACE_MS,
  sandboxConnectionMode,
  sandboxReconnectDeadline,
  sandboxReconnectExpired,
} from "./sandbox-connection.js";
import { redactEvent } from "./redaction.js";
import { collectWorkerSecretValues } from "./worker-env.js";
import {
  sanitizeDisplayName,
  sanitizeParticipantId,
  type LastDecision,
} from "./multiplayer.js";
import type { AgentRun } from "./agent-runs.js";
import { activeMembershipByUserSelect, type MembershipRow } from "./memberships.js";
import {
  authorizeSocketMessage,
  socketAuthFromAttachment,
  type SocketAuthContext,
} from "./ws-authorization.js";
import { sessionIdFromWebSocketPath, verifySocketAuthToken } from "./ws-token.js";
import { verifySandboxWebSocketToken } from "./sandbox-ws-token.js";
import { sendSnapshotIfBehind } from "./snapshot-frame.js";
export { sendSnapshotIfBehind } from "./snapshot-frame.js";
import {
  type Env,
  type InitOptions,
  type SessionMeta,
  PHASE_SPAN_NAMES,
  SNAPSHOT_TERMINAL_EVENT_TYPES,
} from "./orchestrator/types.js";
export { traceSandboxProvisioning } from "./orchestrator/provisioning.js";
import { proxyPreviewRequest } from "./orchestrator/preview.js";
import {
  parseMaxTimeMs,
  traceIdFromSessionId,
} from "./orchestrator/session-guards.js";
export { traceIdFromSessionId } from "./orchestrator/session-guards.js";
import { runOrchestratorSchemaMigrations } from "./orchestrator/schema-migrations.js";
import { DirectoryUpdateQueue } from "./orchestrator/directory-update-queue.js";
import type { OrchestratorHost } from "./orchestrator/host.js";
import { SessionEventLog } from "./orchestrator/event-log.js";
import { notifyExternalConversation } from "./integrations/notify-external-conversation.js";
import { loadSessionMeta, saveSessionMeta } from "./orchestrator/session-meta.js";
import { sessionWideEventGroup } from "./orchestrator/session-telemetry.js";
import {
  completeActiveRun as completeActiveRunFn,
  decisionRejection as decisionRejectionFn,
  ensureActiveRun as ensureActiveRunFn,
  failActiveRunAndReturnReady as failActiveRunAndReturnReadyFn,
  finishRunAndDrainQueue as finishRunAndDrainQueueFn,
  recordDecision as recordDecisionFn,
  setActiveRunState as setActiveRunStateFn,
  startAgentRun as startAgentRunFn,
} from "./orchestrator/agent-run-coordinator.js";
import {
  consumeOpenAnnotations as consumeOpenAnnotationsFn,
  ensureAnnotatableRevision as ensureAnnotatableRevisionFn,
  freezePlanRevision as freezePlanRevisionFn,
  lockPlanRevision as lockPlanRevisionFn,
} from "./orchestrator/plan-revision-actions.js";
import {
  handleAbort,
  handleAgentRequest,
  handleAnnotationCreate,
  handleAnnotationReply,
  handleAnnotationWithdraw,
  handleApprove,
  handleHumanMessage,
  handlePreviewStart,
  handlePreviewStop,
  handleQuestionAnswer,
  handleQuestionAssign,
  handleRefine,
  cancelOpenQuestions as cancelOpenQuestionsFn,
} from "./orchestrator/cli-handlers.js";
import {
  drainQueuedAgentWorkIfWorkspaceCacheSettled,
  dispatchSandboxSocketMessage,
  initializeSandboxConnection,
  provisionSessionSandbox,
} from "./orchestrator/sandbox-handlers.js";
import {
  nextSessionDirectoryTimestamp,
  runSessionDirectoryUpdateWithRetry,
} from "./session-directory.js";
import {
  answerQuestionFromIntegration as answerQuestionFromIntegrationFn,
  type IntegrationQuestionAnswerResult,
} from "./orchestrator/question-answer.js";
import { workerLogForSession, workerLogSessionExceptionForEnv } from "./logging.js";
import { LiveRunCardCoordinator } from "./integrations/slack/live-run-card.js";
import {
  nextWorkspaceCacheJobAt,
  recoverWorkspaceCacheJobAfterRestart,
} from "./orchestrator/workspace-cache-job.js";

export type { InitOptions } from "./orchestrator/types.js";

export class Orchestrator extends DurableObject<Env> implements OrchestratorHost {
  readonly ctx: DurableObjectState<{}>;
  sql: SqlStorage;
  meta: SessionMeta | null = null;
  workerEnv: Env;
  redactionSecrets: string[];
  private tracer: Tracer | null = null;
  private phaseSpans = new Map<SessionState, Span>();
  private directoryUpdates = new DirectoryUpdateQueue();
  private pendingDirectoryPatch: {
    room_state?: string;
    sandbox_state?: string;
    active_run_state?: string | null;
  } = {};
  private lastDirectoryUpdateAt = "";
  eventLog: SessionEventLog;
  private liveRunCards: LiveRunCardCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx = ctx as DurableObjectState<{}>;
    this.workerEnv = env;
    this.redactionSecrets = collectWorkerSecretValues(env);
    this.sql = ctx.storage.sql;
    this.eventLog = new SessionEventLog(
      this.sql,
      () => this.ctx.getWebSockets("cli"),
      (when) => { this.ctx.storage.setAlarm(when); },
      this.redactionSecrets,
      () => this.getTracer(),
      SNAPSHOT_TERMINAL_EVENT_TYPES,
    );

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
    runOrchestratorSchemaMigrations(this.sql);
    this.liveRunCards = new LiveRunCardCoordinator(
      this.sql,
      this.workerEnv,
      () => this.meta?.session_id ?? "",
      () => this.meta?.worker_url ?? "",
      (when) => { void this.ctx.storage.setAlarm(when); },
    );
    const liveRunRetryAt = this.liveRunCards.nextRetryAt();
    if (liveRunRetryAt !== null) void this.ctx.storage.setAlarm(liveRunRetryAt);
    recoverWorkspaceCacheJobAfterRestart(this);
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
      max_time: options.max_time ?? DEFAULT_CONFIG.max_time,
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
    this.ctx.waitUntil(provisionSessionSandbox(this));
    this.armNextAlarmSafe();
  }

  async alarm(): Promise<void> {
    // Persist the snapshot if dirty — this covers the debounce path from
    // scheduleSnapshotPersist(). Reset the flag so the next dirty event can
    // re-arm the alarm via scheduleSnapshotPersist().
    this.eventLog.onAlarm();
    if (this.eventLog.isSnapshotDirty()) {
      // persistSnapshot is synchronous (workerd SqlStorage.exec is sync). If it becomes async, this needs `await`.
      this.eventLog.persistSnapshot();
    }

    this.loadMeta();
    if (!this.meta) return;
    await this.liveRunCards.drainDue(Date.now());

    const now = Date.now();
    if (isTerminalState(this.meta.state)) {
      await this.armNextAlarm(now);
      return;
    }

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
      this.armNextAlarmSafe(Date.now() - 1);
      return;
    }

    if (
      this.meta.sandbox_disconnected_at
      && sandboxReconnectExpired(this.meta.sandbox_disconnected_at, now)
    ) {
      await this.failExpiredSandboxReconnect();
      return;
    }

    if (this.meta.state === "provisioning_sandbox" && now >= createdAt + 60_000) {
      const logs = await readProcessLogs(
        this.workerEnv.Sandbox,
        this.meta.session_id,
        "codevil-agent",
        this.redactionSecrets,
      );
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
      this.armNextAlarmSafe(Date.now() - 1);
      return;
    }

    drainQueuedAgentWorkIfWorkspaceCacheSettled(this);
    this.armNextAlarmSafe(now);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isSandbox = url.pathname.endsWith("/sandbox/ws");

    if (isSandbox) {
      return this.acceptSandboxWebSocket(request, url);
    }

    // Hydrate snapshot and session meta from SQLite on cold-start BEFORE reading
    // snapshotCursor or snapshot.  Without this call both fields are
    // at their constructor defaults (0 / emptySessionSnapshot()), which causes:
    //   1. sendSnapshotIfBehind to skip the snapshot frame (joinCursor >= 0 is always true)
    //   2. replayEvents to replay ALL events instead of only the tail
    //   3. appendAndBroadcast(participant_joined) to dirty the in-memory snapshot
    //      and schedule an alarm that eventually overwrites the persisted snapshot
    //      with an empty-plus-one-participant copy — permanent data loss.
    this.loadMeta();

    const sessionId = this.meta?.session_id ?? sessionIdFromWebSocketPath(url.pathname);
    if (!sessionId) {
      return new Response("Not found", { status: 404 });
    }

    const auth = await verifySocketAuthToken(
      url.searchParams.get("ws_token"),
      sessionId,
      this.workerEnv.CODEVIL_API_KEY,
    );
    if (!auth) {
      return new Response("Unauthorized", { status: 401 });
    }

    const cursorParam = url.searchParams.get("cursor");
    const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

    const participant = this.participantFromRequest(url, auth);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["cli"]);
    server.serializeAttachment({ participant, auth });

    // Send the snapshot frame first if the joiner is behind the snapshot cursor.
    // This lets late joiners hydrate from the snapshot instead of replaying all
    // events from cursor 0.  Fresh sessions have snapshotCursor === 0, so the
    // guard is false and the existing replay path runs unchanged.
    const replayCursor = sendSnapshotIfBehind(
      (data) => server.send(data),
      cursor,
      this.eventLog.getSnapshotCursor(),
      this.eventLog.getSnapshot(),
    );

    this.eventLog.replayEvents(server, replayCursor);
    this.appendAndBroadcast({ type: "participant_joined", participant });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptSandboxWebSocket(request: Request, url: URL): Promise<Response> {
    this.loadMeta();
    if (!this.meta) {
      return new Response("Session not initialized", { status: 409 });
    }

    if (sandboxSessionIdFromPath(url.pathname) !== this.meta.session_id) {
      return new Response("Unauthorized", { status: 401 });
    }

    const capability = await verifySandboxWebSocketToken(
      url.searchParams.get("sandbox_ws_token"),
      this.meta.session_id,
      this.workerEnv.CODEVIL_PROXY_SIGNING_SECRET ?? "",
    );
    if (!capability) return new Response("Unauthorized", { status: 401 });

    const attachedSandboxCount = this.ctx.getWebSockets("sandbox").length;
    const mode = sandboxConnectionMode(this.meta.state, this.meta.sandbox_disconnected_at, attachedSandboxCount);
    if (mode === "reject") {
      this.getTracer()?.log("WARN", "sandbox.ws.rejected", {
        state: this.meta.state,
        disconnected_at: this.meta.sandbox_disconnected_at,
        attached_sandbox_count: attachedSandboxCount,
      });
      return new Response("Sandbox connection is not expected", { status: 409 });
    }

    this.getTracer()?.log("INFO", "sandbox.ws.connected", {
      state: this.meta.state,
      mode,
      attached_sandbox_count: attachedSandboxCount,
    });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["sandbox"]);
    server.serializeAttachment({ sandbox: { aud: capability.aud, role: capability.role, sessionId: capability.sid } });
    initializeSandboxConnection(this, server, mode);
    drainQueuedAgentWorkIfWorkspaceCacheSettled(this);

    if (mode === "resume") {
      this.meta.sandbox_disconnected_at = undefined;
      this.saveMeta();
      this.appendAndBroadcast({ type: "status", message: "Sandbox reconnected." });
      this.updateDirectory({ sandbox_state: "ready" });
      this.armNextAlarmSafe();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    if (this.ctx.getWebSockets("sandbox").includes(ws)) {
      if (!this.isAuthenticatedSandboxSocket(ws)) return;
      await dispatchSandboxSocketMessage(this, ws, message);
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
    if (!msg) {
      ws.send(JSON.stringify({ type: "error", message: clientValidationErrorMessage(raw) }));
      return;
    }

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
        handleHumanMessage(this, msg.text, participant);
        break;
      case "agent_request":
        handleAgentRequest(this, msg.text, participant, msg.plan_first ?? false);
        break;
      case "annotation_create":
        handleAnnotationCreate(this, msg.run_id, msg.round, msg.anchor, msg.comment, participant);
        break;
      case "annotation_reply":
        handleAnnotationReply(this, msg.thread_id, msg.comment, participant);
        break;
      case "annotation_withdraw":
        handleAnnotationWithdraw(this, msg.thread_id, participant);
        break;
      case "question_assign":
        handleQuestionAssign(this, msg, participant, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "question_answer":
        handleQuestionAnswer(this, msg, participant, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "approve":
        handleApprove(this, actor, undefined, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "approve_run":
        handleApprove(this, actor, msg.run_id, socketAuth?.userId ?? null, authz.role ?? null);
        break;
      case "abort":
        handleAbort(this, actor);
        break;
      case "abort_run":
        handleAbort(this, actor, msg.run_id);
        break;
      case "stop_session":
        await this.handleStopSession();
        break;
      case "refine_plan":
        handleRefine(this, msg.feedback, actor);
        break;
      case "refine_run":
        handleRefine(this, msg.feedback, actor, msg.run_id);
        break;
      case "preview_start":
        await handlePreviewStart(this, msg.app_key);
        break;
      case "preview_stop":
        await handlePreviewStop(this);
        break;
      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown message type` }));
    }
  }

  private isAuthenticatedSandboxSocket(ws: WebSocket): boolean {
    const attachment = ws.deserializeAttachment() as { sandbox?: { aud?: unknown; role?: unknown; sessionId?: unknown } } | null;
    return attachment?.sandbox?.aud === "sandbox_ws"
      && attachment.sandbox.role === "sandbox"
      && attachment.sandbox.sessionId === this.meta?.session_id;
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
      if (
        !this.meta.expected_close
        && !isTerminalState(this.meta.state)
      ) {
        const state = this.meta.state;
        if (!this.meta.sandbox_disconnected_at) {
          this.meta.sandbox_disconnected_at = new Date().toISOString();
          this.saveMeta();
          this.appendAndBroadcast({
            type: "status",
            message: "Sandbox connection interrupted. Reconnecting…",
          });
          this.updateDirectory({});
        }
        this.ctx.waitUntil(this.logSandboxDisconnectDiagnostics({
          sessionId: this.meta.session_id,
          closeCode: code,
          closeReason: reason,
          state,
        }));
        this.ctx.waitUntil(this.armNextAlarmSafe());
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
      ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
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
      if (this.meta) {
        leavingSpan.setGroup("session", sessionWideEventGroup(this.meta));
      }
      leavingSpan.setAttribute("state_from", from);
      leavingSpan.setAttribute("state_to", to);
      this.phaseSpans.delete(from);
      leavingSpan.end();
    }
    const enteringName = PHASE_SPAN_NAMES[to];
    if (enteringName) {
      const tracer = this.getTracer();
      if (tracer) {
        const span = tracer.startSpan(enteringName, { attributes: { state: to } });
        if (this.meta) {
          span.setGroup("session", sessionWideEventGroup(this.meta));
        }
        this.phaseSpans.set(to, span);
      }
    }
    if (isTerminalState(to)) {
      for (const [state, span] of this.phaseSpans) {
        if (this.meta) {
          span.setGroup("session", sessionWideEventGroup(this.meta));
        }
        span.setStatus("ERROR", `terminal: ${to}`);
        span.setAttribute("terminal_state", to);
        span.end();
        this.phaseSpans.delete(state);
      }
      if (this.meta) {
        this.getTracer()?.log("INFO", "session.terminal", {
          session: sessionWideEventGroup(this.meta),
          terminal_state: to,
        });
      }
    }

    return true;
  }

  getTracer(): Tracer | null {
    if (this.tracer) return this.tracer;
    this.loadMeta();
    if (!this.meta) return null;
    this.tracer = createTracer({
      component: "orchestrator",
      trace_id: traceIdFromSessionId(this.meta.session_id),
      session_id: this.meta.session_id,
      // Trace records include errors, stacks, span events, and nested diagnostics.
      // Redact at the final sink boundary so new call sites cannot bypass it.
      transform: (line) => redactEvent(line, this.redactionSecrets),
    });
    setValidationDropSink(tracerValidationDropSink(this.tracer));
    return this.tracer;
  }

  currentPhaseSpan(): Span | undefined {
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
    this.armNextAlarmSafe(Date.now() - 1);
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
        ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
      });
    }
    this.closeSandboxSockets(reason);
  }

  // --- OrchestratorHost delegation ---

  loadMeta(): void {
    loadSessionMeta(this.sql, this);
  }

  saveMeta(): void {
    saveSessionMeta(this.sql, this.meta);
  }

  appendAndBroadcast(event: DOToCLIEvent): number | null {
    const cursor = this.eventLog.appendAndBroadcast(event);
    if (cursor !== null && this.meta) {
      try {
        const redactedEvent = redactEvent(event, this.redactionSecrets);
        this.ctx.waitUntil(this.liveRunCards.onEvent(cursor, redactedEvent, this.meta.active_run?.id));
        workerLogForSession(this.meta.session_id, "DEBUG", "external_notification.schedule", {
          cursor,
          event_type: redactedEvent.type,
        }, this.redactionSecrets);
        if (event.type !== "agent_response" && event.type !== "agent_run_failed") {
          this.ctx.waitUntil(notifyExternalConversation({
            env: this.workerEnv,
            sessionId: this.meta.session_id,
            workerOrigin: this.meta.worker_url,
            cursor,
            event: redactedEvent,
          }));
        }
      } catch (error) {
        workerLogSessionExceptionForEnv(this.meta.session_id, "external_notification.schedule.failed", error, this.workerEnv, {
          cursor,
          event_type: event.type,
        });
      }
    }
    return cursor;
  }

  sendToSandbox(message: DOToSandboxMessage): void {
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

  trackCost(cost: CostInfo): void {
    if (!this.meta) return;

    this.meta.cost_total_usd = (this.meta.cost_total_usd ?? 0) + cost.total_cost_usd;
    this.saveMeta();
    this.appendAndBroadcast({
      type: "cost_updated",
      cost_total_usd: this.meta.cost_total_usd,
      turn_cost: cost,
    });
  }

  updateDirectory(patch: {
    room_state?: string;
    sandbox_state?: string;
    active_run_state?: string | null;
  }): void {
    this.loadMeta();
    if (!this.meta) return;

    // Coalesce updates that accumulate while a D1 write is in flight. Each
    // field keeps its latest value, so a terminal state cannot be erased by a
    // burst containing unrelated field updates.
    Object.assign(this.pendingDirectoryPatch, patch);
    const update = this.directoryUpdates.enqueue(() => {
      const pendingPatch = this.pendingDirectoryPatch;
      this.pendingDirectoryPatch = {};
      return this.persistDirectoryUpdate(pendingPatch);
    }, { key: this.meta.session_id });
    this.ctx.waitUntil(update);
  }

  private nextDirectoryUpdateAt(): string {
    const now = new Date().toISOString();
    if (now > this.lastDirectoryUpdateAt) {
      this.lastDirectoryUpdateAt = now;
    } else {
      this.lastDirectoryUpdateAt = new Date(
        Date.parse(this.lastDirectoryUpdateAt) + 1,
      ).toISOString();
    }
    return this.lastDirectoryUpdateAt;
  }

  private async persistDirectoryUpdate(patch: {
    room_state?: string;
    sandbox_state?: string;
    active_run_state?: string | null;
  }): Promise<void> {
    if (!this.meta) return;

    const entries: [string, unknown][] = [
      ["updated_at", ""],
      ["last_event_at", ""],
    ];
    if (patch.room_state !== undefined) entries.push(["room_state", patch.room_state]);
    if (patch.sandbox_state !== undefined) entries.push(["sandbox_state", patch.sandbox_state]);
    if (patch.active_run_state !== undefined) entries.push(["active_run_state", patch.active_run_state]);

    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    // A timed-out D1 request may still finish later. Do not let that older
    // request overwrite a newer state that has already reached the directory.
    const sql = `UPDATE sessions SET ${assignments} WHERE id = ? AND last_event_at < ?`;

    // A restarted DO starts with an empty in-memory clock. A zero-row update
    // means this timestamp was not newer than D1 (or a late attempt already
    // won), so read the baseline and retry with a strictly greater value.
    for (let conflictAttempt = 0; conflictAttempt < 3; conflictAttempt++) {
      const now = this.nextDirectoryUpdateAt();
      entries[0][1] = now;
      entries[1][1] = now;
      const bindings = [...entries.map(([, value]) => value), this.meta.session_id, now];
      const result = await runSessionDirectoryUpdateWithRetry(this.workerEnv.DB, sql, bindings, {
        onFailure: (error) => {
          this.getTracer()?.log("ERROR", "session_directory.update.failed", {
            ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
          });
        },
      });
      if (!result) return;
      if (Number(result.meta.changes ?? 0) > 0) return;

      const current = await this.workerEnv.DB.prepare(
        "SELECT last_event_at FROM sessions WHERE id = ?",
      ).bind(this.meta.session_id).first<{ last_event_at: string }>();
      if (!current) {
        this.getTracer()?.log("ERROR", "session_directory.update.conflict", {
          session_id: this.meta.session_id,
          reason: "session_not_found",
        });
        return;
      }
      this.lastDirectoryUpdateAt = nextSessionDirectoryTimestamp(
        this.lastDirectoryUpdateAt,
        current.last_event_at,
      );
    }

    this.getTracer()?.log("ERROR", "session_directory.update.conflict", {
      session_id: this.meta.session_id,
      reason: "retry_exhausted",
    });
  }

  freezePlanRevision(runId: string, round: number, markdown: string): void {
    freezePlanRevisionFn(this, runId, round, markdown);
  }

  lockPlanRevision(runId: string, round: number): void {
    lockPlanRevisionFn(this, runId, round);
  }

  consumeOpenAnnotations(runId: string, round: number): void {
    consumeOpenAnnotationsFn(this, runId, round);
  }

  ensureAnnotatableRevision(runId: string, round: number): boolean {
    return ensureAnnotatableRevisionFn(this, runId, round);
  }

  ensureActiveRun(runId?: string): boolean {
    return ensureActiveRunFn(this, runId);
  }

  setActiveRunState(state: AgentRunState): void {
    setActiveRunStateFn(this, state);
  }

  startAgentRun(run: AgentRun): void {
    startAgentRunFn(this, run);
  }

  finishRunAndDrainQueue(finalState: AgentRunState): void {
    finishRunAndDrainQueueFn(this, finalState);
  }

  failActiveRunAndReturnReady(message: string): void {
    failActiveRunAndReturnReadyFn(this, message);
  }

  completeActiveRun(prUrl?: string): void {
    completeActiveRunFn(this, prUrl);
  }

  cancelOpenQuestions(runId: string, reason: string): void {
    cancelOpenQuestionsFn(this, runId, reason);
  }

  revokePreview(): void {
    if (!this.meta) return;
    this.meta.preview_active = false;
    this.meta.preview_token_hash = undefined;
    this.meta.preview_url = undefined;
    this.meta.preview_port = undefined;
    this.saveMeta();
  }

  recordDecision(decision: LastDecision): void {
    recordDecisionFn(this, decision);
  }

  decisionRejection(
    attemptedAction: "approve" | "refine",
    fallbackMessage: string,
  ): { type: "error"; message: string; actor?: string } {
    return decisionRejectionFn(this, attemptedAction, fallbackMessage);
  }

  async armNextAlarm(now = Date.now()): Promise<void> {
    if (!this.meta) return;

    const deadlines: number[] = [];
    if (!isTerminalState(this.meta.state)) {
      const createdAt = Date.parse(this.meta.created_at);
      deadlines.push(createdAt + 60_000);
      const maxTimeMs = parseMaxTimeMs(this.meta.max_time);
      if (maxTimeMs !== null) deadlines.push(createdAt + maxTimeMs);
      if (this.meta.sandbox_disconnected_at) {
        deadlines.push(sandboxReconnectDeadline(this.meta.sandbox_disconnected_at));
      }
    }
    const presentationRetryAt = this.liveRunCards.nextRetryAt();
    if (presentationRetryAt !== null) deadlines.push(presentationRetryAt);
    const workspaceCacheRetryAt = nextWorkspaceCacheJobAt(this.sql);
    if (workspaceCacheRetryAt !== null) deadlines.push(workspaceCacheRetryAt);

    const nextDeadline = Math.min(...deadlines.filter((deadline) => deadline > now));
    if (Number.isFinite(nextDeadline)) {
      await this.ctx.storage.setAlarm(nextDeadline);
    }
  }

  private armNextAlarmSafe(now?: number): Promise<void> {
    return this.armNextAlarm(now).catch((error) => {
      this.getTracer()?.log("ERROR", "alarm.arm.failed", {
        ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
      });
    });
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
      const diagnostics = await readSandboxDiagnostics(
        this.workerEnv.Sandbox,
        options.sessionId,
        "codevil-agent",
        this.redactionSecrets,
      );
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
        ...redactEvent(safeExceptionAttributes(error), this.redactionSecrets),
      });
    }
  }

  private async failExpiredSandboxReconnect(): Promise<void> {
    if (!this.meta?.sandbox_disconnected_at) return;

    const activeRunId = this.meta.active_run?.id;
    const message = `Sandbox did not reconnect within ${SANDBOX_RECONNECT_GRACE_MS / 1_000} seconds.`;
    this.transition("failed");
    if (activeRunId) {
      this.meta.active_run = { ...this.meta.active_run!, state: "failed" };
      this.saveMeta();
      this.cancelOpenQuestions(activeRunId, "sandbox reconnect timed out");
      this.appendAndBroadcast({
        type: "agent_run_failed",
        run_id: activeRunId,
        message,
      });
    }
    this.appendAndBroadcast({ type: "error", message });
    this.updateDirectory({
      room_state: "failed",
      sandbox_state: "failed",
      active_run_state: activeRunId ? "failed" : null,
    });
    await this.terminateSandbox("sandbox reconnect timed out");
    this.armNextAlarmSafe(Date.now() - 1);
  }

  async fetchPreview(request: Request, token: string): Promise<Response> {
    this.loadMeta();
    if (!this.meta) {
      return new Response("Preview is not active.", { status: 404 });
    }

    return proxyPreviewRequest(request, this.meta, token, this.workerEnv.Sandbox);
  }

  submitAgentRequest(args: {
    text: string;
    displayText?: string;
    actor: ParticipantIdentity;
    planFirst?: boolean;
  }): { ok: true } | { ok: false; status: number; error: string } {
    this.loadMeta();
    if (!this.meta) {
      return { ok: false, status: 409, error: "Session not initialized" };
    }

    if (!args.text.trim()) {
      return { ok: true };
    }

    this.appendAndBroadcast({ type: "participant_joined", participant: args.actor });
    handleAgentRequest(this, args.text, args.actor, args.planFirst ?? false, args.displayText);
    return { ok: true };
  }

  answerQuestionFromIntegration(args: {
    requestId: string;
    optionIndexes: number[];
    actor: ParticipantIdentity;
  }): IntegrationQuestionAnswerResult {
    this.loadMeta();
    if (!this.meta) {
      return { ok: false, status: "not_open", error: "Session not initialized" };
    }
    return answerQuestionFromIntegrationFn(this, args);
  }
}

function sandboxSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/sandbox\/ws$/);
  return match?.[1] ?? null;
}
