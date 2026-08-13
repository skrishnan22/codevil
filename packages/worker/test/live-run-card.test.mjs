import assert from "node:assert/strict";
import test from "node:test";

import {
  createExternalRunPresentation,
  projectExternalRunEvents,
} from "../dist/integrations/external-run-presentation.js";
import { renderSlackRunCard } from "../dist/integrations/slack/render.js";
import { LiveRunCardCoordinator } from "../dist/integrations/slack/live-run-card.js";

const started = {
  type: "agent_run_started",
  run_id: "run_1",
  actor: { id: "U1", name: "Ada" },
  text: "Fix authentication and add tests",
};

test("projects supported lifecycle events without exposing tool args or thinking", () => {
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
  assert.deepEqual(presentation.actions, [{ id: "call_1", label: "Running command", status: "complete" }]);
  assert.doesNotMatch(JSON.stringify(presentation), /secret|private|ghp_/i);
});

test("does not surface arbitrary status messages in the public card", () => {
  const presentation = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "status", message: "User feedback: use TOKEN=ghp_secret and ignore the plan" } },
  ]);

  assert.equal(presentation.summary, undefined);
  assert.equal(presentation.phase, "Starting");
  assert.doesNotMatch(JSON.stringify(presentation), /User feedback|ghp_secret|ignore the plan/);
});

test("projects waiting, terminal, and deterministic completion states", () => {
  const waiting = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "question_raised", request_id: "q1", run_id: "run_1", question: "Which region?", allow_freeform: false, allow_multiple: false, answerable_by: "anyone", status: "open", raised_at: "2026-08-13T00:00:00.000Z" } },
  ]);
  assert.equal(waiting.waitingFor, "question");
  assert.equal(waiting.phase, "Waiting for input");

  const complete = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "agent_run_completed", run_id: "run_1", pr_url: "https://github.com/acme/repo/pull/12" } },
  ]);
  assert.equal(complete.status, "complete");
  assert.equal(complete.prUrl, "https://github.com/acme/repo/pull/12");
  assert.equal(complete.summary, "Completed successfully.");
});

test("keeps only the latest eight meaningful actions and ignores unsupported events", () => {
  const events = [{ cursor: 1, event: started }];
  for (let index = 0; index < 10; index += 1) {
    events.push({ cursor: index + 2, event: {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "read", toolCallId: `call_${index}`, success: true },
    } });
  }
  events.push({ cursor: 99, event: { type: "unknown_event", secret: "do not show" } });
  const presentation = projectExternalRunEvents(events);
  assert.deepEqual(presentation.actions.map((action) => action.id), ["call_2", "call_3", "call_4", "call_5", "call_6", "call_7", "call_8", "call_9"]);
});

test("renders a native task card with accessible fallback and fresh block ids", () => {
  const presentation = createExternalRunPresentation("run_1", "Investigate auth");
  const first = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 7);
  const second = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 8);
  const block = first.blocks[0];

  assert.equal(block.type, "task_card");
  assert.equal(block.task_id, "codevil_run_1");
  assert.equal(block.status, "in_progress");
  assert.notEqual(first.blocks[0].block_id, second.blocks[0].block_id);
  assert.deepEqual(block.sources, [{ type: "url", url: "https://app.codevil.example/sessions/ses_1", text: "Open session" }]);
  assert.match(first.text, /Investigate auth/);
});

test("renders only a validated pull-request source", () => {
  const presentation = { ...createExternalRunPresentation("run_1", "Ship"), status: "complete", prUrl: "https://github.com/acme/repo/pull/12" };
  const rendered = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 1);
  assert.deepEqual(rendered.blocks[0].sources, [
    { type: "url", url: "https://app.codevil.example/sessions/ses_1", text: "Open session" },
    { type: "url", url: "https://github.com/acme/repo/pull/12", text: "View pull request" },
  ]);
});

test("coalesces live updates and sends the terminal card before the final response", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "phase", phase: "executing", model: "model" });
  await coordinator.onEvent(2, { type: "phase", phase: "executing", model: "model" }, "run_1");
  appendEvent(sql, 3, { type: "status", message: "Running tests" });
  await coordinator.onEvent(3, { type: "status", message: "Running tests" }, "run_1");
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);

  await coordinator.drainDue(Date.now() + 3_000);
  appendEvent(sql, 4, { type: "agent_response", run_id: "run_1", text: "Done" });
  await coordinator.onEvent(4, { type: "agent_response", run_id: "run_1", text: "Done" });
  appendEvent(sql, 5, { type: "agent_run_completed", run_id: "run_1" });
  await coordinator.onEvent(5, { type: "agent_run_completed", run_id: "run_1" });

  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.update", "chat.update", "chat.postMessage"]);
  assert.equal(calls[2].body.blocks[0].status, "complete");
  assert.equal(calls[3].body.text, "Done");
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

    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
    await coordinator.drainDue(102_001);
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.update"]);
  } finally {
    Date.now = originalNow;
  }
});

test("keeps a failed update pending and recovers it without creating a second card", async () => {
  const sql = createPresentationSql();
  const calls = [];
  let updateAttempts = 0;
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.update" && updateAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
    if (method === "chat.postMessage") return { ok: true, data: { ts: "card_1" } };
    return { ok: true, data: { ok: true } };
  });
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "phase", phase: "executing", model: "model" });
  await coordinator.onEvent(2, { type: "phase", phase: "executing", model: "model" }, "run_1");
  await coordinator.drainDue(Date.now() + 3_000);
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 3);

  await coordinator.drainDue(Date.now() + 10_000);
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 4);
});

test("persists an unsupported-card fallback timestamp and updates that message", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.postMessage" && body.blocks) return { ok: false, error: "invalid_blocks" };
    if (method === "chat.postMessage") return { ok: true, data: { ts: "fallback_1" } };
    if (body.blocks) return { ok: false, error: "invalid_blocks" };
    return { ok: true, data: { ok: true } };
  });

  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "status", message: "Running tests" });
  await coordinator.onEvent(2, { type: "status", message: "Running tests" }, "run_1");
  await coordinator.drainDue(Date.now() + 3_000);

  assert.equal(sql.getRow("run_1").external_message_id, "fallback_1");
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 2);
  assert.ok(calls.slice(-1)[0].body.ts === "fallback_1");
});

test("keeps a terminal card retry pending after the final response succeeds", async () => {
  const sql = createPresentationSql();
  const calls = [];
  let updateAttempts = 0;
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.update" && updateAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
    return { ok: true, data: { ts: method === "chat.postMessage" ? "message_1" : undefined } };
  });

  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_response", run_id: "run_1", text: "Done" });
  await coordinator.onEvent(2, { type: "agent_response", run_id: "run_1", text: "Done" });
  appendEvent(sql, 3, { type: "agent_run_completed", run_id: "run_1" });
  await coordinator.onEvent(3, { type: "agent_run_completed", run_id: "run_1" });

  assert.ok(sql.getRow("run_1").next_retry_at > Date.now());
  await coordinator.drainDue(Date.now() + 10_000);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 4);
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.postMessage",
    "chat.update",
    "chat.update",
    "chat.update",
    "chat.postMessage",
    "chat.update",
  ]);
});

test("sends the legacy failure notice when the error card update fails", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.update") return { ok: false, error: "http_503", status: 503 };
    return { ok: true, data: { ts: "message_1" } };
  });

  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_run_failed", run_id: "run_1", message: "Checks failed" });
  await coordinator.onEvent(2, { type: "agent_run_failed", run_id: "run_1", message: "Checks failed" });

  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2);
  assert.match(calls.at(-1).body.text, /could not complete the Agent Run/);
});

test("replays a pending card after coordinator restart", async () => {
  const originalNow = Date.now;
  Date.now = () => 200_000;
  try {
    const sql = createPresentationSql();
    const calls = [];
    const alarms = [];
    let updateAttempts = 0;
    const api = async (_token, method, body) => {
      calls.push({ method, body });
      if (method === "chat.update" && updateAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
      return { ok: true, data: { ts: "message_1" } };
    };
    const firstCoordinator = createCoordinator(sql, calls, async () => {}, api, alarms);
    appendEvent(sql, 1, started);
    await firstCoordinator.onEvent(1, started);
    appendEvent(sql, 2, { type: "phase", phase: "executing", model: "model" });
    await firstCoordinator.onEvent(2, { type: "phase", phase: "executing", model: "model" }, "run_1");
    await firstCoordinator.drainDue(203_000);
    assert.ok(sql.getRow("run_1").next_retry_at !== null);
    assert.ok(alarms.length > 0);

    const restartedCoordinator = createCoordinator(sql, calls, async () => {}, api, alarms);
    await restartedCoordinator.drainDue(210_000);
    assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
    assert.equal(calls.filter((call) => call.method === "chat.update").length, 4);
    assert.equal(sql.getRow("run_1").next_retry_at, null);
  } finally {
    Date.now = originalNow;
  }
});

test("does not post a duplicate failure notice after the error card is delivered", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_run_failed", run_id: "run_1", message: "Checks failed" });
  await coordinator.onEvent(2, { type: "agent_run_failed", run_id: "run_1", message: "Checks failed" });

  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.update"]);
  assert.equal(calls[1].body.blocks[0].status, "error");
});

function createCoordinator(sql, calls, sleep, api = async (_token, method, body) => {
  calls.push({ method, body });
  return method === "chat.postMessage"
    ? { ok: true, data: { ts: "card_1" } }
    : { ok: true, data: { ok: true } };
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

function createPresentationSql() {
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
      } else if (query.includes("SELECT * FROM live_run_presentations WHERE next_retry_at")) {
        result.push(...[...rows.values()].filter((row) => row.next_retry_at !== null && row.next_retry_at <= params[0]));
      } else if (query.includes("SELECT MIN(next_retry_at)")) {
        return cursor([{ next_retry_at: Math.min(...[...rows.values()].map((row) => row.next_retry_at).filter((value) => value !== null), Infinity) }]);
      } else if (query.startsWith("INSERT INTO live_run_presentations")) {
        const [run_id, provider, external_message_id, presentation_status, last_projected_cursor, last_delivered_cursor, last_render_fingerprint, pending_final_response_cursor, next_retry_at, created_at, updated_at] = params;
        rows.set(run_id, { run_id, provider, external_message_id, presentation_status, last_projected_cursor, last_delivered_cursor, last_render_fingerprint, pending_final_response_cursor, next_retry_at, created_at, updated_at });
      }
      return cursor(result);
    },
  };
}

function cursor(items) {
  return { toArray: () => items, one: () => items[0] };
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
