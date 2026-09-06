import type { DOToCLIEvent } from "@codevil/shared";
import type { Env } from "../../orchestrator/types.js";
import { redactEvent } from "../../redaction.js";
import { workerLogForSession } from "../../logging.js";
import { externalConversationDestinationBySessionSelect } from "../store.js";
import type { ExternalConversationDestination } from "../types.js";
import {
  createSlackWebApi,
  setSlackThreadStatus,
  type SlackApi,
  type SlackApiResult,
} from "./client.js";
import {
  projectExternalRunEvents,
  type ExternalRunPresentation,
  type ExternalRunStep,
} from "../external-run-presentation.js";
import { notifyExternalConversation } from "../notify-external-conversation.js";

const CARD_COALESCE_MS = 2_000;
const STATUS_HEARTBEAT_MS = 90_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_STATUS_LENGTH = 150;

interface LiveRunPresentationRow {
  run_id: string;
  provider: string;
  external_message_id: string | null;
  presentation_status: string;
  last_projected_cursor: number;
  last_delivered_cursor: number;
  last_render_fingerprint: string | null;
  pending_final_response_cursor: number | null;
  next_retry_at: number | null;
  card_delete_pending_at: number | null;
  created_at: string;
  updated_at: string;
}

export class LiveRunCardCoordinator {
  private readonly api: SlackApi;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly flushing = new Set<string>();

  constructor(
    private readonly storageSql: SqlStorage,
    private readonly env: Env,
    private readonly sessionId: () => string,
    private readonly workerOrigin: () => string,
    private readonly scheduleAlarm: (when: number) => void,
    api?: SlackApi,
    sleep: (delayMs: number) => Promise<void> = sleepFor,
  ) {
    this.api = api ?? createSlackWebApi();
    this.sleep = sleep;
  }

  async onEvent(cursor: number, event: DOToCLIEvent, activeRunId?: string): Promise<void> {
    const runId = runIdForEvent(event) ?? activeRunId;
    if (!runId || !isLiveRunEvent(event)) return;

    if (!this.env.SLACK_BOT_TOKEN) return;

    const now = Date.now();
    const existing = this.row(runId);
    const pendingFinalResponseCursor = event.type === "agent_response"
      ? cursor
      : event.type === "agent_run_completed" || event.type === "agent_run_failed"
        ? existing?.pending_final_response_cursor ?? cursor
        : existing?.pending_final_response_cursor ?? null;
    this.upsert({
      run_id: runId,
      provider: "slack",
      external_message_id: existing?.external_message_id ?? null,
      presentation_status: existing?.presentation_status ?? "in_progress",
      last_projected_cursor: Math.max(existing?.last_projected_cursor ?? 0, cursor),
      last_delivered_cursor: existing?.last_delivered_cursor ?? 0,
      last_render_fingerprint: existing?.last_render_fingerprint ?? null,
      pending_final_response_cursor: pendingFinalResponseCursor,
      next_retry_at: nextRetryAt(existing?.next_retry_at ?? null, event, now),
      card_delete_pending_at: null,
      created_at: existing?.created_at ?? new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    this.scheduleAlarm(now + (shouldFlushImmediately(event) ? 1 : CARD_COALESCE_MS));
    try {
      await this.flush(runId);
    } catch (error) {
      this.log("ERROR", "slack_thread_status.flush.failed", runId, { error: redactEvent(error, this.envSecrets()) });
    }
  }

  async drainDue(now = Date.now()): Promise<void> {
    const rows = this.rowsDue(now);
    await Promise.all(rows.map((row) => this.flush(row.run_id, true)));
  }

  nextRetryAt(): number | null {
    const row = this.sql().exec(
      "SELECT MIN(next_retry_at) AS next_retry_at FROM live_run_presentations WHERE next_retry_at IS NOT NULL",
    ).one() as { next_retry_at: number | null } | undefined;
    return row?.next_retry_at ?? null;
  }

  private async flush(runId: string, force = false): Promise<void> {
    if (this.flushing.has(runId)) return;
    this.flushing.add(runId);
    try {
      for (;;) {
        const row = this.row(runId);
        if (!row) return;
        const now = Date.now();
        if (!force && row.next_retry_at !== null && row.next_retry_at > now) return;
        force = false;

        const presentation = this.project(runId);
        if (row.presentation_status === "uncertain") {
          this.upsert({ ...row, next_retry_at: null });
          if (isTerminal(presentation)) await this.deliverFinalResponse(row, presentation);
          return;
        }

        const status = slackThreadStatus(presentation);
        const fingerprint = status ?? "";
        if (isTerminal(presentation)) {
          this.upsert({
            ...row,
            last_delivered_cursor: Math.max(row.last_delivered_cursor, row.last_projected_cursor),
            last_render_fingerprint: fingerprint,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          });
          await this.deliverFinalResponse(this.row(runId) ?? row, presentation);
          return;
        }

        if (status === null) {
          this.upsert({
            ...row,
            last_delivered_cursor: Math.max(row.last_delivered_cursor, row.last_projected_cursor),
            last_render_fingerprint: fingerprint,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          });
          return;
        }

        if (row.last_delivered_cursor >= row.last_projected_cursor && row.last_render_fingerprint === fingerprint) {
          const heartbeat = await this.deliverStatus(row, status);
          if (!heartbeat.ok) {
            if (heartbeat.uncertain) {
              this.upsert({ ...row, presentation_status: "uncertain", next_retry_at: null });
              return;
            }
            const retryAt = Date.now() + heartbeat.retryAfterMs;
            this.upsert({ ...row, next_retry_at: retryAt, updated_at: new Date().toISOString() });
            this.scheduleAlarm(retryAt);
            return;
          }
          const retryAt = Date.now() + STATUS_HEARTBEAT_MS;
          this.upsert({ ...row, next_retry_at: retryAt, updated_at: new Date().toISOString() });
          this.scheduleAlarm(retryAt);
          return;
        }

        const delivered = await this.deliverStatus(row, status);
        if (!delivered.ok) {
          if (delivered.uncertain) {
            this.upsert({ ...row, presentation_status: "uncertain", next_retry_at: null });
            return;
          }
          const retryAt = Date.now() + delivered.retryAfterMs;
          this.upsert({ ...row, next_retry_at: retryAt, updated_at: new Date().toISOString() });
          this.scheduleAlarm(retryAt);
          return;
        }

        const current = this.row(runId) ?? row;
        const retryAt = Date.now() + STATUS_HEARTBEAT_MS;
        this.upsert({
          ...current,
          presentation_status: presentation.status,
          last_delivered_cursor: Math.max(current.last_delivered_cursor, row.last_projected_cursor),
          last_render_fingerprint: fingerprint,
          next_retry_at: retryAt,
          updated_at: new Date().toISOString(),
        });
        this.scheduleAlarm(retryAt);

        const latest = this.row(runId);
        if (!latest || latest.last_projected_cursor <= latest.last_delivered_cursor) return;
        if (latest.next_retry_at !== null && latest.next_retry_at > Date.now()) return;
      }
    } finally {
      this.flushing.delete(runId);
    }
  }

  private async deliverStatus(
    row: LiveRunPresentationRow,
    status: string,
  ): Promise<{ ok: true } | { ok: false; retryAfterMs: number; uncertain?: boolean }> {
    const destination = await this.destination();
    if (!destination || !this.env.SLACK_BOT_TOKEN) {
      return { ok: false, retryAfterMs: BASE_RETRY_DELAY_MS, uncertain: true };
    }

    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      let result: SlackApiResult<unknown>;
      try {
        result = await setSlackThreadStatus(this.api, this.env.SLACK_BOT_TOKEN, {
          channelId: destination.external_channel_id,
          threadTs: destination.external_conversation_id,
          status,
        });
      } catch {
        result = { ok: false, error: "network_error" };
      }
      if (result.ok) return { ok: true };
      if (isPermanentStatusFailure(result)) {
        this.log("ERROR", "slack_thread_status.delivery.permanent", row.run_id, {
          cursor: row.last_projected_cursor,
          attempt,
          error: result.error,
        });
        return { ok: false, retryAfterMs: BASE_RETRY_DELAY_MS, uncertain: true };
      }
      if (result.retryAfterMs !== undefined || !isRetryable(result) || attempt === MAX_DELIVERY_ATTEMPTS) {
        this.log("ERROR", "slack_thread_status.delivery.exhausted", row.run_id, {
          cursor: row.last_projected_cursor,
          attempt,
          error: result.error,
        });
        return { ok: false, retryAfterMs: retryDelay(result, MAX_DELIVERY_ATTEMPTS) };
      }
      const delay = retryDelay(result, attempt);
      this.log("WARN", "slack_thread_status.delivery.retrying", row.run_id, {
        cursor: row.last_projected_cursor,
        attempt,
        delay_ms: delay,
        error: result.error,
      });
      await this.sleep(delay);
    }
    return { ok: false, retryAfterMs: BASE_RETRY_DELAY_MS };
  }

  private async deliverFinalResponse(row: LiveRunPresentationRow, presentation: ExternalRunPresentation): Promise<void> {
    const pending = row.pending_final_response_cursor;
    if (pending === null) return;
    const events = this.eventsForRun(row.run_id);
    const response = [...events].reverse().find((entry) => entry.event.type === "agent_response");
    const terminal = [...events].reverse().find((entry) => entry.event.type === "agent_run_completed" || entry.event.type === "agent_run_failed");
    if (!terminal) return;
    const event = response?.event.type === "agent_response"
      ? response.event
      : terminal.event.type === "agent_run_failed"
        ? terminal.event
        : { type: "agent_response", run_id: row.run_id, text: `Completed.${presentation.prUrl ? ` Draft PR: ${presentation.prUrl}` : ""}` } as DOToCLIEvent;
    const delivered = await notifyExternalConversation({
      env: this.env,
      sessionId: this.sessionId(),
      workerOrigin: this.workerOrigin(),
      cursor: response?.cursor ?? terminal.cursor,
      event,
    }, { slackApi: this.api, sleep: this.sleep, random: () => 0 });
    if (delivered) {
      this.deleteRow(row.run_id);
    } else {
      const latest = this.row(row.run_id);
      if (latest) {
        const nextRetryAt = Date.now() + BASE_RETRY_DELAY_MS;
        this.upsert({ ...latest, next_retry_at: nextRetryAt, updated_at: new Date().toISOString() });
        this.scheduleAlarm(nextRetryAt);
      }
    }
  }

  private project(runId: string): ExternalRunPresentation {
    return projectExternalRunEvents(this.eventsForRun(runId));
  }

  private eventsForRun(runId: string): Array<{ cursor: number; event: DOToCLIEvent }> {
    const rows = this.sql().exec("SELECT id, event_json FROM events ORDER BY id ASC").toArray() as Array<{ id: number; event_json: string }>;
    const parsed = rows.flatMap((row) => {
      try {
        const event = JSON.parse(row.event_json) as DOToCLIEvent;
        return [{ cursor: row.id, event }];
      } catch {
        return [];
      }
    });
    const runEntries = parsed.filter((entry) => runIdForEvent(entry.event) === runId);
    if (runEntries.length === 0) return [];
    const startIndex = runEntries.findIndex((entry) => entry.event.type === "agent_run_started");
    if (startIndex < 0) return runEntries;
    const startCursor = runEntries[startIndex].cursor;
    let terminalCursor: number | null = null;
    for (let index = runEntries.length - 1; index >= 0; index -= 1) {
      const type = runEntries[index].event.type;
      if (type === "agent_run_completed" || type === "agent_run_failed") {
        terminalCursor = runEntries[index].cursor;
        break;
      }
    }
    const globals = parsed.filter((entry) =>
      (entry.event.type === "status" || entry.event.type === "phase" || entry.event.type === "agent_event")
      && entry.cursor >= startCursor
      && (terminalCursor === null || entry.cursor <= terminalCursor));
    return [...runEntries, ...globals].sort((a, b) => a.cursor - b.cursor);
  }

  private async destination(): Promise<ExternalConversationDestination | null> {
    const statement = externalConversationDestinationBySessionSelect(this.sessionId());
    return await this.env.DB.prepare(statement.sql).bind(...statement.bindings).first<ExternalConversationDestination>();
  }

  private sql(): SqlStorage { return this.storageSql; }

  private row(runId: string): LiveRunPresentationRow | null {
    return (this.sql().exec("SELECT * FROM live_run_presentations WHERE run_id = ?", runId).toArray()[0] as unknown as LiveRunPresentationRow | undefined) ?? null;
  }

  private rowsDue(now: number): LiveRunPresentationRow[] {
    return this.sql().exec("SELECT * FROM live_run_presentations WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?", now).toArray() as unknown as LiveRunPresentationRow[];
  }

  private deleteRow(runId: string): void {
    this.sql().exec("DELETE FROM live_run_presentations WHERE run_id = ?", runId);
  }

  private upsert(row: LiveRunPresentationRow): void {
    this.sql().exec(`INSERT INTO live_run_presentations (
      run_id, provider, external_message_id, presentation_status, last_projected_cursor,
      last_delivered_cursor, last_render_fingerprint, pending_final_response_cursor,
      next_retry_at, card_delete_pending_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      provider = excluded.provider,
      external_message_id = excluded.external_message_id,
      presentation_status = excluded.presentation_status,
      last_projected_cursor = excluded.last_projected_cursor,
      last_delivered_cursor = excluded.last_delivered_cursor,
      last_render_fingerprint = excluded.last_render_fingerprint,
      pending_final_response_cursor = excluded.pending_final_response_cursor,
      next_retry_at = excluded.next_retry_at,
      card_delete_pending_at = excluded.card_delete_pending_at,
      updated_at = excluded.updated_at`,
    row.run_id, row.provider, row.external_message_id, row.presentation_status, row.last_projected_cursor,
    row.last_delivered_cursor, row.last_render_fingerprint, row.pending_final_response_cursor,
    row.next_retry_at, row.card_delete_pending_at, row.created_at, row.updated_at);
  }

  private envSecrets(): string[] {
    return [this.env.SLACK_BOT_TOKEN, this.env.GITHUB_PAT, this.env.CODEVIL_API_KEY].filter((value): value is string => Boolean(value));
  }

  private log(severity: "DEBUG" | "INFO" | "WARN" | "ERROR", event: string, runId: string, attributes: Record<string, unknown>): void {
    workerLogForSession(this.sessionId(), severity, event, { run_id: runId, provider: "slack", ...attributes }, this.envSecrets());
  }
}

export function slackThreadStatus(presentation: ExternalRunPresentation): string | null {
  if (presentation.waitingFor !== undefined) return null;
  if (presentation.status !== "in_progress") return null;
  if (presentation.queuedPosition !== undefined) {
    return `is in queue (position ${presentation.queuedPosition})...`;
  }
  const active = [...presentation.steps].reverse().find((step) => step.status === "active");
  if (active) return statusFromStep(active);
  return boundedStatus(`is ${presentation.phase.toLowerCase()}...`);
}

function statusFromStep(step: ExternalRunStep): string {
  const detail = step.detail ? ` — ${step.detail}` : "";
  return boundedStatus(`is ${step.label.toLowerCase()}${detail}...`);
}

function boundedStatus(value: string): string {
  if (value.length <= MAX_STATUS_LENGTH) return value;
  return `${value.slice(0, MAX_STATUS_LENGTH - 3).trimEnd()}...`;
}

function runIdForEvent(event: DOToCLIEvent): string | undefined {
  return "run_id" in event && typeof event.run_id === "string" ? event.run_id : undefined;
}

function isLiveRunEvent(event: DOToCLIEvent): boolean {
  return ["agent_request", "agent_request_queued", "agent_run_started", "phase", "status", "agent_event", "question_raised", "question_answered", "approval_requested", "plan_execution_started", "agent_response", "agent_run_completed", "agent_run_failed"].includes(event.type);
}

function shouldFlushImmediately(event: DOToCLIEvent): boolean {
  return event.type === "agent_request"
    || event.type === "agent_request_queued"
    || event.type === "agent_run_started"
    || event.type === "question_raised"
    || event.type === "question_answered"
    || event.type === "approval_requested"
    || event.type === "plan_execution_started"
    || event.type === "agent_run_completed"
    || event.type === "agent_run_failed";
}

function nextRetryAt(existing: number | null, event: DOToCLIEvent, now: number): number {
  if (shouldFlushImmediately(event)) return now;
  const coalesceAt = now + CARD_COALESCE_MS;
  if (existing !== null && existing > now && existing <= coalesceAt) return existing;
  return coalesceAt;
}

function isTerminal(presentation: ExternalRunPresentation): boolean {
  return presentation.status === "complete" || presentation.status === "error";
}

function isRetryable(result: Extract<SlackApiResult<unknown>, { ok: false }>): boolean {
  return result.status === 429 || (result.status !== undefined && result.status >= 500) || ["rate_limited", "ratelimited", "request_timeout", "network_error"].includes(result.error) || /^http_5\d\d$/.test(result.error);
}

function isPermanentStatusFailure(result: Extract<SlackApiResult<unknown>, { ok: false }>): boolean {
  return [
    "channel_not_found",
    "invalid_thread_ts",
    "method_not_supported_for_channel_type",
    "method_deprecated",
    "missing_scope",
    "invalid_auth",
    "no_permission",
    "not_in_channel",
    "not_allowed_token_type",
    "feature_disabled",
    "invalid_arguments",
    "not_authed",
    "account_inactive",
    "token_revoked",
    "token_expired",
  ].includes(result.error);
}

function retryDelay(result: SlackApiResult<unknown>, attempt: number): number {
  if (!result.ok && result.retryAfterMs !== undefined) return result.retryAfterMs;
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
