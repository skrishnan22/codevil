import { DurableObject } from "cloudflare:workers";
import type {
  SessionState,
  DOToCLIEvent,
  CLIToDOMessage,
} from "@codevil/shared";
import { isValidTransition, isTerminalState, MAX_REFINEMENT_ROUNDS } from "@codevil/shared";

interface SessionMeta {
  session_id: string;
  prompt: string;
  repo: string;
  state: SessionState;
  refinement_round: number;
  verification_attempts: number;
  created_at: string;
}

export class Orchestrator extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;
  private meta: SessionMeta | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
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

  async init(sessionId: string, prompt: string, repo: string): Promise<void> {
    this.meta = {
      session_id: sessionId,
      prompt,
      repo,
      state: "initializing",
      refinement_round: 0,
      verification_attempts: 0,
      created_at: new Date().toISOString(),
    };
    this.saveMeta();

    this.appendAndBroadcast({ type: "session_created", session_id: sessionId });
    this.appendAndBroadcast({ type: "status", message: "Session created. Waiting for sandbox provisioning." });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const cursorParam = url.searchParams.get("cursor");
    const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [cursor.toString()]);
    this.replayEvents(server, cursor);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

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

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {
    // Connection already closed by runtime; no action needed.
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
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
      { state: "plan_ready", event: { type: "plan_ready", plan: "## Test Plan\n\n1. Step one\n2. Step two", cost: { input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.01 }, refinement_round: 0 } },
      { state: "awaiting_approval", event: { type: "status", message: "Waiting for user approval." } },
    ];

    for (const step of steps) {
      if (this.transition(step.state)) {
        this.appendAndBroadcast(step.event);
      }
    }
  }

  // --- Event log ---

  private appendAndBroadcast(event: DOToCLIEvent): void {
    const json = JSON.stringify(event);
    this.sql.exec("INSERT INTO events (event_json) VALUES (?)", json);

    const row = this.sql.exec(
      "SELECT id FROM events ORDER BY id DESC LIMIT 1"
    ).one() as { id: number };

    const envelope = JSON.stringify({ cursor: row.id, event });
    for (const ws of this.ctx.getWebSockets()) {
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
