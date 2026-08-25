import type { DOToCLIEvent } from "@codevil/shared";
import type { Env } from "../../orchestrator/types.js";
import { redactEvent } from "../../redaction.js";
import { workerLogForSession } from "../../logging.js";
import { externalConversationDestinationBySessionSelect } from "../store.js";
import type { ExternalConversationDestination } from "../types.js";
import { externalSessionUrl } from "../session-url.js";
import {
  createSlackWebApi,
  deleteSlackMessage,
  postSlackMessage,
  updateSlackMessage,
  type SlackApi,
  type SlackApiResult,
} from "./client.js";
import { renderSlackRunCard } from "./render.js";
import {
  projectExternalRunEvents,
  type ExternalRunPresentation,
} from "../external-run-presentation.js";
import { notifyExternalConversation } from "../notify-external-conversation.js";

const CARD_COALESCE_MS = 2_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;

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

    const destination = await this.destination();
    if (!destination) return;

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
      card_delete_pending_at: existing?.card_delete_pending_at ?? null,
      created_at: existing?.created_at ?? new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    this.scheduleAlarm(now + (shouldFlushImmediately(event) ? 1 : CARD_COALESCE_MS));
    try {
      await this.flush(runId);
    } catch (error) {
      this.log("ERROR", "live_run_card.flush.failed", runId, { error: redactEvent(error, this.envSecrets()) });
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
        // The run resolved and the response was delivered: only the card
        // teardown remains. Never re-render in this state.
        if (row.card_delete_pending_at !== null) {
          await this.closeCard(row);
          return;
        }
        const now = Date.now();
        if (!force && row.next_retry_at !== null && row.next_retry_at > now) return;
        force = false;

        const presentation = this.project(runId);
        const fingerprint = JSON.stringify(presentation);
        if (row.last_delivered_cursor >= row.last_projected_cursor && row.last_render_fingerprint === fingerprint) {
          if (isTerminal(presentation)) await this.deliverFinalResponse(row, presentation);
          return;
        }

        const destination = await this.destination();
        if (!destination || !this.env.SLACK_BOT_TOKEN) return;
        const message = renderSlackRunCard(presentation, externalSessionUrl({ CODEVIL_WEB_ORIGIN: this.env.CODEVIL_WEB_ORIGIN }, this.workerOrigin(), this.sessionId()), row.last_projected_cursor);
        const delivered = await this.deliverCard(row, destination, message, presentation);
        if (!delivered.ok) {
          this.upsert({ ...row, next_retry_at: Date.now() + delivered.retryAfterMs, updated_at: new Date().toISOString() });
          if (isTerminal(presentation)) await this.deliverFinalResponse(row, presentation);
          this.scheduleAlarm(Date.now() + delivered.retryAfterMs);
          return;
        }

        const current = this.row(runId) ?? row;
        this.upsert({
          ...current,
          external_message_id: delivered.messageId ?? current.external_message_id,
          presentation_status: presentation.status,
          last_delivered_cursor: Math.max(current.last_delivered_cursor, row.last_projected_cursor),
          last_render_fingerprint: fingerprint,
          next_retry_at: null,
          updated_at: new Date().toISOString(),
        });
        if (isTerminal(presentation)) await this.deliverFinalResponse(this.row(runId) ?? current, presentation);

        const latest = this.row(runId);
        if (!latest || latest.last_projected_cursor <= latest.last_delivered_cursor) return;
        const latestPresentation = this.project(runId);
        if (!isTerminal(latestPresentation) && latest.next_retry_at !== null && latest.next_retry_at > Date.now()) return;
      }
    } finally {
      this.flushing.delete(runId);
    }
  }

  private async deliverCard(
    row: LiveRunPresentationRow,
    destination: ExternalConversationDestination,
    message: ReturnType<typeof renderSlackRunCard>,
    presentation: ExternalRunPresentation,
  ): Promise<{ ok: true; messageId?: string } | { ok: false; retryAfterMs: number }> {
    const retry = async (operation: () => Promise<SlackApiResult<unknown>>): Promise<SlackApiResult<unknown>> => {
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        const result = await operation();
        if (result.ok) return result;
        if (!isRetryable(result) || attempt === MAX_DELIVERY_ATTEMPTS) {
          this.log("ERROR", "live_run_card.delivery.exhausted", row.run_id, { cursor: row.last_projected_cursor, attempt, error: result.error });
          return result;
        }
        const delay = retryDelay(result, attempt);
        this.log("WARN", "live_run_card.delivery.retrying", row.run_id, { cursor: row.last_projected_cursor, attempt, delay_ms: delay, error: result.error });
        await this.sleep(delay);
      }
      return { ok: false, error: "retry_exhausted" };
    };

    if (!row.external_message_id) {
      const posted = await retry(() => postSlackMessage(this.api, this.env.SLACK_BOT_TOKEN!, {
        channel: destination.external_channel_id,
        threadTs: destination.external_conversation_id,
        ...message,
      }));
      if (posted.ok) {
        const data = posted.data as { ts?: unknown };
        if (typeof data.ts === "string") return { ok: true, messageId: data.ts };
        return { ok: false, retryAfterMs: BASE_RETRY_DELAY_MS };
      }
      if (isUnsupportedCardFailure(posted)) {
        const fallback = await retry(() => postSlackMessage(this.api, this.env.SLACK_BOT_TOKEN!, {
          channel: destination.external_channel_id,
          threadTs: destination.external_conversation_id,
          text: fallbackText(presentation, this.workerOrigin(), this.sessionId(), this.env.CODEVIL_WEB_ORIGIN),
        }));
        if (fallback.ok) {
          const data = fallback.data as { ts?: unknown };
          if (typeof data.ts === "string") return { ok: true, messageId: data.ts };
        }
      }
      return { ok: false, retryAfterMs: retryDelay(posted, MAX_DELIVERY_ATTEMPTS) };
    }

    const updated = await retry(() => updateSlackMessage(this.api, this.env.SLACK_BOT_TOKEN!, {
      channel: destination.external_channel_id,
      ts: row.external_message_id!,
      ...message,
    }));
    if (updated.ok) return { ok: true, messageId: row.external_message_id };
    if (isUnsupportedCardFailure(updated)) {
      const fallback = await retry(() => updateSlackMessage(this.api, this.env.SLACK_BOT_TOKEN!, {
        channel: destination.external_channel_id,
        ts: row.external_message_id!,
        text: fallbackText(presentation, this.workerOrigin(), this.sessionId(), this.env.CODEVIL_WEB_ORIGIN),
      }));
      if (fallback.ok) return { ok: true, messageId: row.external_message_id };
      return { ok: false, retryAfterMs: retryDelay(fallback, MAX_DELIVERY_ATTEMPTS) };
    }
    return { ok: false, retryAfterMs: retryDelay(updated, MAX_DELIVERY_ATTEMPTS) };
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
      const latest = this.row(row.run_id);
      if (latest) {
        this.upsert({ ...latest, pending_final_response_cursor: null, updated_at: new Date().toISOString() });
        await this.closeCard(this.row(row.run_id) ?? latest);
      }
    } else {
      const latest = this.row(row.run_id);
      if (latest) {
        const nextRetryAt = Date.now() + BASE_RETRY_DELAY_MS;
        this.upsert({ ...latest, next_retry_at: nextRetryAt, updated_at: new Date().toISOString() });
        this.scheduleAlarm(nextRetryAt);
      }
    }
  }

  /**
   * Tear down the card for a resolved run: delete the Slack message, then drop
   * the presentation row. Survives restarts via the DO alarm when the delete
   * itself fails.
   */
  private async closeCard(row: LiveRunPresentationRow): Promise<void> {
    if (!row.external_message_id) {
      this.deleteRow(row.run_id);
      return;
    }
    const destination = await this.destination();
    if (!destination || !this.env.SLACK_BOT_TOKEN) {
      // Nothing else can ever delete a card we cannot address; drop the row so
      // the session does not keep retrying forever.
      this.log("WARN", "live_run_card.close.no_destination", row.run_id, {});
      this.deleteRow(row.run_id);
      return;
    }
    const deleting = this.row(row.run_id) ?? row;
    if (deleting.card_delete_pending_at === null) {
      this.upsert({ ...deleting, card_delete_pending_at: Date.now(), updated_at: new Date().toISOString() });
    }
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const result = await deleteSlackMessage(this.api, this.env.SLACK_BOT_TOKEN, {
        channel: destination.external_channel_id,
        ts: row.external_message_id!,
      });
      if (result.ok || isMessageAlreadyGone(result)) {
        this.deleteRow(row.run_id);
        return;
      }
      if (!isRetryable(result)) {
        this.log("ERROR", "live_run_card.close.exhausted", row.run_id, { attempt, error: result.error, status: result.status });
        // Permanent failure (auth etc.): leave the card in place and stop
        // retrying — the response messages are already delivered.
        this.deleteRow(row.run_id);
        return;
      }
      if (attempt === MAX_DELIVERY_ATTEMPTS) {
        // Transient failures that outlast the in-flight retries: keep the row
        // and let the DO alarm retry the delete later.
        const latest = this.row(row.run_id);
        if (latest) {
          const nextRetryAt = Date.now() + BASE_RETRY_DELAY_MS;
          this.upsert({ ...latest, next_retry_at: nextRetryAt, updated_at: new Date().toISOString() });
          this.scheduleAlarm(nextRetryAt);
        }
        return;
      }
      const delay = retryDelay(result, attempt);
      this.log("WARN", "live_run_card.close.retrying", row.run_id, { attempt, delay_ms: delay, error: result.error });
      await this.sleep(delay);
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
    // Runs interleave in the log: a request is logged immediately, the run may
    // start much later after queued requests from other turns. Global progress
    // events (status/phase/agent_event) carry no run id, so attribute them to
    // the run whose execution window covers the cursor: from that run's
    // agent_run_started until its own terminal event. Its pre-start window
    // (while queued) belongs to whatever run was executing then.
    const runEntries = parsed.filter((entry) => runIdForEvent(entry.event) === runId);
    if (runEntries.length === 0) return [];
    const startCursor = runEntries.find((entry) => entry.event.type === "agent_run_started")?.cursor
      ?? runEntries[0].cursor;
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
  if (existing !== null && existing > now) return existing;
  return now + CARD_COALESCE_MS;
}

function fallbackText(
  presentation: ExternalRunPresentation,
  workerOrigin: string,
  sessionId: string,
  webOrigin?: string,
): string {
  const state = presentation.status === "complete"
    ? "Completed successfully."
    : presentation.status === "error"
      ? presentation.summary ?? "The Agent Run failed."
      : presentation.queuedPosition !== undefined
        ? `Codevil is in queue (position ${presentation.queuedPosition}).`
        : `Codevil is working on: ${presentation.title}.`;
  return `${state} Open session: ${externalSessionUrl({ CODEVIL_WEB_ORIGIN: webOrigin }, workerOrigin, sessionId)}`;
}

function isTerminal(presentation: ExternalRunPresentation): boolean {
  return presentation.status === "complete" || presentation.status === "error";
}

function isRetryable(result: Extract<SlackApiResult<unknown>, { ok: false }>): boolean {
  return result.status === 429 || (result.status !== undefined && result.status >= 500) || ["rate_limited", "ratelimited", "request_timeout", "network_error"].includes(result.error) || /^http_5\d\d$/.test(result.error);
}

/** Deletes are idempotent: a message that is already gone counts as success. */
function isMessageAlreadyGone(result: Extract<SlackApiResult<unknown>, { ok: false }>): boolean {
  return result.status === 404 || ["message_not_found", "channel_not_found", "is_archived"].includes(result.error);
}

function isUnsupportedCardFailure(result: Extract<SlackApiResult<unknown>, { ok: false }>): boolean {
  return ["invalid_blocks", "invalid_blocks_format", "invalid_arguments", "method_not_supported"].includes(result.error);
}

function retryDelay(result: SlackApiResult<unknown>, attempt: number): number {
  if (!result.ok && result.retryAfterMs !== undefined) return Math.min(result.retryAfterMs, MAX_RETRY_DELAY_MS);
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}