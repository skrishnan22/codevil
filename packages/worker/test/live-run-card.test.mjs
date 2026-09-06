import assert from "node:assert/strict";
import test from "node:test";

import {
  projectExternalRunEvents,
} from "../dist/integrations/external-run-presentation.js";
import { LiveRunCardCoordinator, slackThreadStatus } from "../dist/integrations/slack/live-run-card.js";

const started = {
  type: "agent_run_started",
  run_id: "run_1",
  actor: { id: "U1", name: "Ada" },
  text: "Fix authentication and add tests",
};

test("keeps the clean request title when the run starts with an enriched prompt", () => {
  const presentation = projectExternalRunEvents([
    { cursor: 1, event: { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Improve landing page header and colors", created_at: "2026-08-28T00:00:00.000Z" } },
    { cursor: 2, event: { type: "agent_run_started", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Source: Slack thread\n\nThread context:\nSlack U2: old context\n\nExplicit request:\nSlack U1: Improve landing page header and colors" } },
  ]);
  assert.equal(presentation.title, "Improve landing page header and colors");
  assert.doesNotMatch(presentation.title, /Source:|Slack U1/);
});

test("keeps started-only enriched prompts out of the public title", () => {
  const enrichedText = "Source: Slack thread\n\nThread context:\nSlack U2: old context\n\nExplicit request:\nSlack U1: Improve landing page header and colors";
  const presentation = projectExternalRunEvents([
    { cursor: 1, event: { type: "agent_run_started", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: enrichedText } },
  ]);

  assert.equal(presentation.title, "Improve landing page header and colors");
  assert.doesNotMatch(presentation.title, /Source:|Slack U1|Slack U2|Thread context/);

  const withoutExplicitRequest = projectExternalRunEvents([
    { cursor: 1, event: { type: "agent_run_started", run_id: "run_2", actor: { id: "U1", name: "Ada" }, text: "Source: Slack thread\n\nThread context:\nSlack U2: old context" } },
  ]);
  assert.equal(withoutExplicitRequest.title, "Agent Run");
});

test("preserves a bounded clean started-only title", () => {
  const presentation = projectExternalRunEvents([
    { cursor: 1, event: started },
  ]);

  assert.equal(presentation.title, "Fix authentication and add tests");
});

test("projects supported lifecycle events into a redacted, granular step list", () => {
  const presentation = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "phase", phase: "planning", model: "secret-model" } },
    { cursor: 3, event: {
      type: "agent_event",
      event: { type: "tool_execution_start", tool: "bash", toolCallId: "call_1", args: { command: "cat secret.txt" } },
    } },
    { cursor: 4, event: {
      type: "agent_event",
      event: { type: "message_update", content: "private reasoning" },
    } },
    { cursor: 5, event: {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "bash", toolCallId: "call_1", result: "TOKEN=ghp_secret", success: true },
    } },
  ]);

  assert.equal(presentation.title, "Fix authentication and add tests");
  assert.equal(presentation.phase, "Preparing");
  assert.deepEqual(presentation.steps, [{ id: "call_1", label: "Running commands", detail: undefined, status: "done", rank: 3 }]);
  assert.doesNotMatch(JSON.stringify(presentation), /secret|private|ghp_/i);
  assert.equal(slackThreadStatus(presentation), "is preparing...");
});

test("maps each tool family to a granular label and folds bash args into no detail", () => {
  const cases = [
    ["read", "Reading files"],
    ["grep", "Searching code"],
    ["ls", "Exploring files"],
    ["edit", "Editing code"],
    ["bash", "Running commands"],
    ["ask_question", "Asking you something"],
    ["web_search", "Fetching web content"],
    ["run_tests", "Running checks"],
    ["mystery_tool", "Calling mystery_tool"],
  ];
  for (const [tool, label] of cases) {
    const presentation = projectExternalRunEvents([
      { cursor: 1, event: started },
      { cursor: 2, event: { type: "agent_event", event: { type: "tool_execution_start", tool, toolCallId: `c_${tool}` } } },
    ]);
    assert.equal(presentation.steps[0].label, label, `tool ${tool}`);
  }

  const withPath = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "agent_event", event: { type: "tool_execution_start", tool: "edit", toolCallId: "c_e", args: { file_path: "src/auth/login.ts" } } } },
  ]);
  assert.equal(withPath.steps[0].detail, "login.ts");
  assert.equal(slackThreadStatus(withPath), "is editing code — login.ts...");

  const bash = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "agent_event", event: { type: "tool_execution_start", tool: "bash", toolCallId: "c_b", args: { command: "export KEY=sk-secret-abcdefghijklmnopqrstuvwxyz123456" } } } },
  ]);
  assert.equal(bash.steps[0].detail, undefined);
  assert.doesNotMatch(JSON.stringify(bash), /sk-secret/i);
});

test("windows steps to a bounded recent list", () => {
  const events = [{ cursor: 1, event: started }];
  for (let index = 0; index < 12; index += 1) {
    events.push({ cursor: index + 2, event: {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "read", toolCallId: `call_${index}`, success: true },
    } });
  }
  const presentation = projectExternalRunEvents(events);
  assert.equal(presentation.steps.length, 10);
  assert.equal(presentation.droppedSteps, 2);
  assert.equal(slackThreadStatus(presentation), "is investigating...");
});

test("shows a queued run with its queue position until it starts", () => {
  const queued = projectExternalRunEvents([
    { cursor: 1, event: { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth", created_at: "2026-08-25T00:00:00.000Z" } },
    { cursor: 2, event: { type: "agent_request_queued", run_id: "run_1", position: 2 } },
  ]);
  assert.equal(queued.queuedPosition, 2);
  assert.equal(queued.phase, "Queued");
  assert.equal(slackThreadStatus(queued), "is in queue (position 2)...");

  const running = projectExternalRunEvents([
    queued && { cursor: 3, event: started },
  ].filter(Boolean));
  assert.equal(running.queuedPosition, undefined);
  assert.equal(running.status, "in_progress");
  assert.equal(slackThreadStatus(running), "is starting...");
});

test("does not set status while waiting for a question or approval", () => {
  const waiting = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "question_raised", request_id: "q1", run_id: "run_1", question: "Which region?", allow_freeform: false, allow_multiple: false, answerable_by: "anyone", status: "open", raised_at: "2026-08-13T00:00:00.000Z" } },
  ]);
  assert.equal(waiting.waitingFor, "question");
  assert.equal(slackThreadStatus(waiting), null);

  const approval = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "approval_requested", run_id: "run_1", plan: "Update the header." } },
  ]);
  assert.equal(approval.waitingFor, "approval");
  assert.equal(slackThreadStatus(approval), null);
});

test("projects terminal and deterministic completion states", () => {
  const complete = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "agent_run_completed", run_id: "run_1", pr_url: "https://github.com/acme/repo/pull/12" } },
  ]);
  assert.equal(complete.status, "complete");
  assert.equal(complete.prUrl, "https://github.com/acme/repo/pull/12");
  assert.equal(complete.summary, "Completed successfully.");
  assert.equal(slackThreadStatus(complete), null);
});

test("sets thread status immediately for a new request, even before the run starts", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth", created_at: "2026-08-25T00:00:00.000Z" });
  await coordinator.onEvent(1, { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth", created_at: "2026-08-25T00:00:00.000Z" });
  assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus"]);
  assert.equal(calls[0].body.status, "is starting...");

  appendEvent(sql, 2, { type: "agent_request_queued", run_id: "run_1", position: 2 });
  await coordinator.onEvent(2, { type: "agent_request_queued", run_id: "run_1", position: 2 });
  assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus", "assistant.threads.setStatus"]);
  assert.equal(calls[1].body.status, "is in queue (position 2)...");
});

test("coalesces live updates, then delivers the final response without posting a card", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "phase", phase: "executing", model: "model" });
  await coordinator.onEvent(2, { type: "phase", phase: "executing", model: "model" }, "run_1");
  appendEvent(sql, 3, { type: "status", message: "Running tests" });
  await coordinator.onEvent(3, { type: "status", message: "Running tests" }, "run_1");
  assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus"]);
  assert.equal(calls[0].body.status, "is starting...");

  await coordinator.drainDue(Date.now() + 3_000);
  assert.equal(calls.at(-1).body.status, "is verifying...");
  appendEvent(sql, 4, { type: "agent_response", run_id: "run_1", text: "Done" });
  await coordinator.onEvent(4, { type: "agent_response", run_id: "run_1", text: "Done" });
  appendEvent(sql, 5, { type: "agent_run_completed", run_id: "run_1" });
  await coordinator.onEvent(5, { type: "agent_run_completed", run_id: "run_1" });

  const methods = calls.map((call) => call.method);
  assert.deepEqual(methods, ["assistant.threads.setStatus", "assistant.threads.setStatus", "chat.postMessage"]);
  assert.equal(calls[2].body.text, "Done");
  assert.equal(sql.getRow("run_1"), undefined);
});

test("delivers the failure notice without deleting a card", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_run_failed", run_id: "run_1", message: "Tests failed" });
  await coordinator.onEvent(2, { type: "agent_run_failed", run_id: "run_1", message: "Tests failed" });

  assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus", "chat.postMessage"]);
  assert.match(calls[1].body.text, /could not complete the Agent Run/);
  assert.equal(sql.getRow("run_1"), undefined);
});

test("first status event tolerates a missing presentation row", async () => {
  const sql = createPresentationSql({ strictPresentationRowRead: true });
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});

  appendEvent(sql, 1, started);
  await assert.doesNotReject(() => coordinator.onEvent(1, started));

  assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus"]);
});

test("keeps one coalescing deadline while activity continues", async () => {
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  try {
    const sql = createPresentationSql();
    const calls = [];
    const coordinator = createCoordinator(sql, calls, async () => {});
    appendEvent(sql, 1, started);
    await coordinator.onEvent(1, started);

    now += 1;
    appendEvent(sql, 2, { type: "phase", phase: "executing", model: "model" });
    await coordinator.onEvent(2, { type: "phase", phase: "executing", model: "model" }, "run_1");
    now += 1;
    appendEvent(sql, 3, { type: "agent_event", event: { type: "tool_execution_start", tool: "read", toolCallId: "call_1" } });
    await coordinator.onEvent(3, { type: "agent_event", event: { type: "tool_execution_start", tool: "read", toolCallId: "call_1" } }, "run_1");
    now += 1;
    appendEvent(sql, 4, { type: "status", message: "Running tests" });
    await coordinator.onEvent(4, { type: "status", message: "Running tests" }, "run_1");

    assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus"]);
    await coordinator.drainDue(102_001);
    assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus", "assistant.threads.setStatus"]);
    assert.equal(calls[1].body.status, "is reading files...");
  } finally {
    Date.now = originalNow;
  }
});

test("keeps a failed status update pending and recovers it", async () => {
  const sql = createPresentationSql();
  const calls = [];
  let statusAttempts = 0;
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "assistant.threads.setStatus" && statusAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
    return { ok: true, data: { ok: true } };
  });
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  assert.equal(calls.filter((call) => call.method === "assistant.threads.setStatus").length, 3);

  await coordinator.drainDue(Date.now() + 10_000);
  assert.equal(calls.filter((call) => call.method === "assistant.threads.setStatus").length, 4);
});

test("stops retrying after a permanent Slack status error", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    return { ok: false, error: "method_not_supported_for_channel_type" };
  });
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  await coordinator.drainDue(Date.now() + 10_000);
  assert.equal(calls.filter((call) => call.method === "assistant.threads.setStatus").length, 1);
  assert.equal(sql.getRow("run_1").presentation_status, "uncertain");
});

test("heartbeats the same status before Slack's two-minute timeout", async () => {
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  try {
    const sql = createPresentationSql();
    const calls = [];
    const coordinator = createCoordinator(sql, calls, async () => {});
    appendEvent(sql, 1, started);
    await coordinator.onEvent(1, started);
    assert.equal(calls.length, 1);

    now += 90_000;
    await coordinator.drainDue(now);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "assistant.threads.setStatus");
    assert.equal(calls[1].body.status, "is starting...");
  } finally {
    Date.now = originalNow;
  }
});

test("does not set status when waiting for a question", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "question_raised", request_id: "q1", run_id: "run_1", question: "Which region?", allow_freeform: false, allow_multiple: false, answerable_by: "anyone", status: "open", raised_at: "2026-08-13T00:00:00.000Z" });
  await coordinator.onEvent(2, { type: "question_raised", request_id: "q1", run_id: "run_1", question: "Which region?", allow_freeform: false, allow_multiple: false, answerable_by: "anyone", status: "open", raised_at: "2026-08-13T00:00:00.000Z" });
  assert.deepEqual(calls.map((call) => call.method), ["assistant.threads.setStatus"]);
  assert.equal(sql.getRow("run_1").last_render_fingerprint, "");
});

test("queued turns surface live progress after they start, each status resolves independently", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});

  const req = (n, text) => ({ type: "agent_request", run_id: `run_${n}`, actor: { id: "U1", name: "Ada" }, text, created_at: "2026-08-25T00:00:00.000Z" });
  const queued = (n) => ({ type: "agent_request_queued", run_id: `run_${n}`, position: 1 });
  const startedR = (n, text) => ({ type: "agent_run_started", run_id: `run_${n}`, actor: { id: "U1", name: "Ada" }, text });

  let cursor = 0;
  const append = async (event, activeRunId) => {
    cursor += 1;
    appendEvent(sql, cursor, event);
    await coordinator.onEvent(cursor, event, activeRunId);
  };

  await append(req(1, "First task"), "run_1");
  await append(startedR(1, "First task"), "run_1");
  await append({ type: "status", message: "Running setup" }, "run_1");
  await append(req(2, "Second task"), "run_1");
  await append(queued(2), "run_1");
  await append(req(3, "Third task"), "run_1");
  await append(queued(3), "run_1");

  assert.equal(calls.filter((call) => call.method === "assistant.threads.setStatus").length, 6);

  await append({ type: "agent_run_completed", run_id: "run_1" }, "run_1");
  await append(startedR(2, "Second task"), "run_2");
  await append({ type: "status", message: "Running tests" }, "run_2");
  await append({ type: "agent_event", event: { type: "tool_execution_start", tool: "edit", toolCallId: "c2", args: { file_path: "src/a.ts" } } }, "run_2");
  await coordinator.drainDue(Date.now() + 3_000);

  const statusUpdates = calls.filter((call) => call.method === "assistant.threads.setStatus");
  const run2Live = statusUpdates.filter((call) => call.body.status.includes("editing code")).at(-1);
  assert.ok(run2Live, "run 2 should have a live status");
  assert.match(run2Live.body.status, /a\.ts/);
  assert.doesNotMatch(run2Live.body.status, /queue/);

  await append({ type: "agent_response", run_id: "run_2", text: "Second done" }, "run_2");
  await append({ type: "agent_run_completed", run_id: "run_2" }, "run_2");

  assert.equal(calls.filter((call) => call.method === "chat.delete").length, 0);
  assert.equal(sql.getRow("run_1"), undefined);
  assert.equal(sql.getRow("run_2"), undefined);
  assert.notEqual(sql.getRow("run_3"), undefined);
});

test("never folds another run's live progress into a queued status", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});

  const req = (n, text) => ({ type: "agent_request", run_id: `run_${n}`, actor: { id: "U1", name: "Ada" }, text, created_at: "2026-08-25T00:00:00.000Z" });
  const queued = (n, position) => ({ type: "agent_request_queued", run_id: `run_${n}`, position });
  const startedR = (n, text) => ({ type: "agent_run_started", run_id: `run_${n}`, actor: { id: "U1", name: "Ada" }, text });

  let cursor = 0;
  const append = async (event, activeRunId) => {
    cursor += 1;
    appendEvent(sql, cursor, event);
    await coordinator.onEvent(cursor, event, activeRunId);
  };

  await append(req(1, "First task"), "run_1");
  await append(startedR(1, "First task"), "run_1");
  await append(req(2, "Second task"), "run_1");
  await append(queued(2, 1), "run_1");
  await append({ type: "status", message: "Running tests" }, "run_1");
  await append({ type: "agent_event", event: { type: "tool_execution_start", tool: "read", toolCallId: "c1", args: { file_path: "src/lib.ts" } } }, "run_1");
  await coordinator.drainDue(Date.now() + 3_000);

  const queuedStatuses = calls.filter((call) => call.method === "assistant.threads.setStatus" && call.body.status.includes("queue"));
  assert.ok(queuedStatuses.at(-1));
  assert.equal(queuedStatuses.at(-1).body.status, "is in queue (position 1)...");
  const run2Fingerprints = sql.getRow("run_2").last_render_fingerprint;
  assert.equal(run2Fingerprints, "is in queue (position 1)...");
});

test("retries a lost initial status after a network error", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const api = async (_token, method, body) => {
    calls.push({ method, body });
    return { ok: false, error: "network_error" };
  };
  appendEvent(sql, 1, started);
  const coordinator = createCoordinator(sql, calls, async () => {}, api);
  await coordinator.onEvent(1, started);
  await coordinator.drainDue(Date.now() + 100_000);
  assert.ok(calls.filter((call) => call.method === "assistant.threads.setStatus").length > 1);
});

function createCoordinator(sql, calls, sleep, api = async (_token, method, body) => {
  calls.push({ method, body });
  return { ok: true, data: method === "chat.postMessage" ? { ts: "msg_1" } : { ok: true } };
}, alarms = []) {
  const env = {
    DB: fakeD1(),
    SLACK_BOT_TOKEN: "xoxb-test",
    CODEVIL_API_KEY: "not-a-secret-for-this-test",
  };
  return new LiveRunCardCoordinator(
    sql,
    env,
    () => "ses_1",
    () => "https://worker.codevil.example",
    (when) => alarms.push(when),
    api,
    sleep,
  );
}

function appendEvent(sql, cursor, event) {
  sql.events.push({ id: cursor, event_json: JSON.stringify(event) });
}

function createPresentationSql({ strictPresentationRowRead = false } = {}) {
  const rows = new Map();
  const events = [];
  return {
    events,
    getRow(runId) {
      return rows.get(runId);
    },
    exec(query, ...params) {
      const result = [];
      if (query.startsWith("SELECT id, event_json FROM events")) result.push(...events);
      else if (query.includes("SELECT * FROM live_run_presentations WHERE run_id")) {
        const row = rows.get(params[0]);
        if (row) result.push(row);
        if (strictPresentationRowRead) return strictCursor(result);
      } else if (query.includes("SELECT * FROM live_run_presentations WHERE next_retry_at")) {
        result.push(...[...rows.values()].filter((row) => row.next_retry_at !== null && row.next_retry_at <= params[0]));
      } else if (query.includes("SELECT MIN(next_retry_at)")) {
        return cursor([{ next_retry_at: Math.min(...[...rows.values()].map((row) => row.next_retry_at).filter((value) => value !== null), Infinity) }]);
      } else if (query.startsWith("DELETE FROM live_run_presentations")) {
        rows.delete(params[0]);
        return cursor([]);
      } else if (query.startsWith("INSERT INTO live_run_presentations")) {
        const [run_id, provider, external_message_id, presentation_status, last_projected_cursor, last_delivered_cursor, last_render_fingerprint, pending_final_response_cursor, next_retry_at, card_delete_pending_at, created_at, updated_at] = params;
        rows.set(run_id, { run_id, provider, external_message_id, presentation_status, last_projected_cursor, last_delivered_cursor, last_render_fingerprint, pending_final_response_cursor, next_retry_at, card_delete_pending_at, created_at, updated_at });
      }
      return cursor(result);
    },
  };
}

function cursor(items) {
  return { toArray: () => items, one: () => items[0] };
}

function strictCursor(items) {
  return {
    toArray: () => items,
    one() {
      if (items.length === 0) throw new Error("Expected exactly one result from SQL query, but got no results.");
      return items[0];
    },
  };
}

function fakeD1() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("external_session_links") ? {
              provider: "slack",
              integration_id: "int_slack_T123",
              external_channel_id: "C123",
              external_conversation_id: "171951.0001",
            } : null,
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
}
