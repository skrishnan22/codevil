import assert from "node:assert/strict";
import test from "node:test";

import {
  createExternalRunPresentation,
  projectExternalRunEvents,
  MAX_VISIBLE_STEPS,
} from "../dist/integrations/external-run-presentation.js";
import { renderSlackRunCard } from "../dist/integrations/slack/render.js";
import { LiveRunCardCoordinator } from "../dist/integrations/slack/live-run-card.js";

const started = {
  type: "agent_run_started",
  run_id: "run_1",
  actor: { id: "U1", name: "Ada" },
  text: "Fix authentication and add tests",
};

function detailsLines(presentation, sessionUrl = "https://app.codevil.example/sessions/ses_1") {
  const rendered = renderSlackRunCard(presentation, sessionUrl, 1);
  return activityRows(rendered.blocks[0]).map(textFromRichTextSection);
}

function activityRows(card) {
  const activity = card.child_blocks?.find((block) =>
    block.type === "rich_text" && block.elements?.some((section) =>
      /^[…✓×●]/u.test(textFromRichTextSection(section))));
  return activity?.elements ?? [];
}

function textFromRichTextSection(section) {
  return (section.elements ?? []).map((element) => element.text ?? "").join("");
}

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

test("renders a default-expanded card with chronological, explicit activity rows", () => {
  const presentation = projectExternalRunEvents([
    { cursor: 1, event: { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Improve the landing page", created_at: "2026-08-28T00:00:00.000Z" } },
    ...[2, 3, 4].map((cursor) => ({
      cursor,
      event: { type: "agent_event", event: { type: "tool_execution_end", tool: "read", toolCallId: `read_${cursor}`, success: true } },
    })),
    { cursor: 5, event: { type: "agent_event", event: { type: "tool_execution_start", tool: "edit", toolCallId: "edit_1", args: { file_path: "src/Hero.astro" } } } },
  ]);

  const card = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 7).blocks[0];
  assert.equal(card.type, "container");
  assert.equal(card.is_collapsible, true);
  assert.equal(card.default_collapsed, false);
  assert.equal(card.title.text, presentation.title);
  assert.doesNotMatch(card.title.text, /✅|🔄|❌|💬/u);

  const activity = activityRows(card);
  assert.deepEqual(activity.map(textFromRichTextSection), [
    "… 2 earlier steps",
    "✓ Completed — Reading files",
    "● Running — Editing code — Hero.astro",
  ]);
  assert.deepEqual(activity.at(-1).elements[1], {
    type: "text",
    text: "Running",
    style: { bold: true },
  });
  assert.equal(detailsLines(presentation).filter((line) => /^(?:●|✓|✗) /.test(line)).length, 2);
});

test("renders failed rows and counts dropped, collapsed, and windowed steps", () => {
  const presentation = {
    ...createExternalRunPresentation("run_1", "Ship the fix"),
    steps: [
      { id: "old-1", label: "Reading files", status: "done", rank: 1 },
      { id: "old-2", label: "Reading files", status: "done", rank: 2 },
      { id: "middle", label: "Searching code", status: "error", rank: 3 },
      { id: "visible-1", label: "Editing code", status: "done", rank: 4 },
      { id: "visible-2", label: "Running checks", status: "error", rank: 5 },
      { id: "visible-3", label: "Publishing changes", status: "active", rank: 6 },
    ],
    droppedSteps: 2,
  };

  assert.deepEqual(detailsLines(presentation), [
    "… 5 earlier steps",
    "✓ Completed — Editing code",
    "× Failed — Running checks",
    "● Running — Publishing changes",
  ]);
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

  const bash = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "agent_event", event: { type: "tool_execution_start", tool: "bash", toolCallId: "c_b", args: { command: "export KEY=sk-secret-abcdefghijklmnopqrstuvwxyz123456" } } } },
  ]);
  assert.equal(bash.steps[0].detail, undefined);
  assert.doesNotMatch(JSON.stringify(bash), /sk-secret/i);
});

test("windows steps to the current step plus a few older ones on the card", () => {
  const events = [{ cursor: 1, event: started }];
  for (let index = 0; index < 12; index += 1) {
    events.push({ cursor: index + 2, event: {
      type: "agent_event",
      event: { type: "tool_execution_end", tool: "read", toolCallId: `call_${index}`, success: true },
    } });
  }
  const presentation = projectExternalRunEvents(events);
  // Internal cap keeps the fingerprint bounded; the card renders only the tail.
  assert.equal(presentation.steps.length, 10);
  assert.equal(presentation.droppedSteps, 2);
  assert.equal(MAX_VISIBLE_STEPS, 3);

  const lines = detailsLines(presentation);
  const stepLines = lines.filter((line) => line.startsWith("✓"));
  assert.equal(stepLines.length, 1);
  assert.deepEqual(stepLines.map((line) => line.split(" — ")[1]), [
    "Reading files",
  ]);
  assert.ok(lines.some((line) => /… 11 earlier steps/.test(line)));
});

test("shows a queued run with its queue position until it starts", () => {
  const queued = projectExternalRunEvents([
    { cursor: 1, event: { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth", created_at: "2026-08-25T00:00:00.000Z" } },
    { cursor: 2, event: { type: "agent_request_queued", run_id: "run_1", position: 2 } },
  ]);
  assert.equal(queued.queuedPosition, 2);
  assert.equal(queued.phase, "Queued");
  assert.equal(renderSlackRunCard(queued, "https://app.codevil.example/sessions/ses_1", 1).blocks[0].subtitle.text, "In queue (position 2)");

  const running = projectExternalRunEvents([
    queued && { cursor: 3, event: started },
  ].filter(Boolean));
  assert.equal(running.queuedPosition, undefined);
  assert.equal(running.status, "in_progress");
});

test("projects waiting, terminal, and deterministic completion states", () => {
  const waiting = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "question_raised", request_id: "q1", run_id: "run_1", question: "Which region?", allow_freeform: false, allow_multiple: false, answerable_by: "anyone", status: "open", raised_at: "2026-08-13T00:00:00.000Z" } },
  ]);
  assert.equal(waiting.waitingFor, "question");
  assert.equal(waiting.phase, "Waiting for input");
  assert.equal(renderSlackRunCard(waiting, "https://app.codevil.example/sessions/ses_1", 1).blocks[0].subtitle.text, "Waiting for input");

  const approval = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "approval_requested", run_id: "run_1", plan: "Update the header." } },
  ]);
  assert.equal(renderSlackRunCard(approval, "https://app.codevil.example/sessions/ses_1", 1).blocks[0].subtitle.text, "Waiting for approval");

  const complete = projectExternalRunEvents([
    { cursor: 1, event: started },
    { cursor: 2, event: { type: "agent_run_completed", run_id: "run_1", pr_url: "https://github.com/acme/repo/pull/12" } },
  ]);
  assert.equal(complete.status, "complete");
  assert.equal(complete.prUrl, "https://github.com/acme/repo/pull/12");
  assert.equal(complete.summary, "Completed successfully.");
});

test("renders a container with accessible fallback and fresh block ids", () => {
  const presentation = createExternalRunPresentation("run_1", "Investigate auth");
  const first = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 7);
  const second = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 8);
  const block = first.blocks[0];

  assert.equal(block.type, "container");
  assert.equal(block.title.text, "Investigate auth");
  assert.equal(block.subtitle.text, "Starting");
  assert.equal(block.is_collapsible, true);
  assert.equal(block.default_collapsed, false);
  assert.notEqual(first.blocks[0].block_id, second.blocks[0].block_id);
  assert.deepEqual(block.child_blocks.at(-1).elements[0].elements, [
    { type: "link", url: "https://app.codevil.example/sessions/ses_1", text: "Open Codevil" },
  ]);
  assert.match(first.text, /Investigate auth/);
});

test("keeps the terminal summary in the subtitle instead of repeating it in activity", () => {
  const presentation = {
    ...createExternalRunPresentation("run_1", "Ship"),
    status: "complete",
    phase: "Complete",
    summary: "Completed successfully.",
  };
  const rendered = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 1);

  assert.doesNotMatch(JSON.stringify(rendered.blocks[0].child_blocks), /Completed successfully\./);
  assert.equal(rendered.blocks[0].subtitle.text, "Completed successfully.");
});

test("renders only a validated pull-request source", () => {
  const presentation = { ...createExternalRunPresentation("run_1", "Ship"), status: "complete", summary: "Completed successfully.", steps: [], droppedSteps: 0, prUrl: "https://github.com/acme/repo/pull/12" };
  const rendered = renderSlackRunCard(presentation, "https://app.codevil.example/sessions/ses_1", 1);
  assert.deepEqual(rendered.blocks[0].child_blocks.at(-1).elements[0].elements, [
    { type: "link", url: "https://app.codevil.example/sessions/ses_1", text: "Open Codevil" },
    { type: "text", text: " · " },
    { type: "link", url: "https://github.com/acme/repo/pull/12", text: "View pull request" },
  ]);
});

test("posts a card immediately for a new request, even before the run starts", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth", created_at: "2026-08-25T00:00:00.000Z" });
  await coordinator.onEvent(1, { type: "agent_request", run_id: "run_1", actor: { id: "U1", name: "Ada" }, text: "Fix auth", created_at: "2026-08-25T00:00:00.000Z" });
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.match(calls[0].body.text, /Fix auth/);

  appendEvent(sql, 2, { type: "agent_request_queued", run_id: "run_1", position: 2 });
  await coordinator.onEvent(2, { type: "agent_request_queued", run_id: "run_1", position: 2 });
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.update"]);
  assert.match(JSON.stringify(calls[1].body), /In queue \(position 2\)/);
});

test("coalesces live updates, then delivers the final response and deletes the card", async () => {
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

  const methods = calls.map((call) => call.method);
  assert.deepEqual(methods, ["chat.postMessage", "chat.update", "chat.update", "chat.postMessage", "chat.delete"]);
  const terminalUpdate = calls[2];
  assert.equal(terminalUpdate.body.blocks[0].subtitle.text, "Completed successfully.");
  assert.equal(calls[3].body.text, "Done");
  assert.equal(calls[4].method, "chat.delete");
  assert.equal(sql.getRow("run_1"), undefined);
});

test("deletes the card on failure after sending the failure notice", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});
  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_run_failed", run_id: "run_1", message: "Tests failed" });
  await coordinator.onEvent(2, { type: "agent_run_failed", run_id: "run_1", message: "Tests failed" });

  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.update", "chat.postMessage", "chat.delete"]);
  assert.equal(calls[1].body.blocks[0].subtitle.text, "Verification failed.");
  assert.match(calls[2].body.text, /could not complete the Agent Run/);
  assert.equal(sql.getRow("run_1"), undefined);
});

test("first live card event tolerates a missing presentation row", async () => {
  const sql = createPresentationSql({ strictPresentationRowRead: true });
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {});

  appendEvent(sql, 1, started);
  await assert.doesNotReject(() => coordinator.onEvent(1, started));

  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
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

test("retries a failed card deletion via the alarm, then removes the row", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const alarms = [];
  let deleteAttempts = 0;
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.delete" && deleteAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
    if (method === "chat.postMessage") return { ok: true, data: { ts: "card_1" } };
    return { ok: true, data: { ok: true } };
  }, alarms);

  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_response", run_id: "run_1", text: "Done" });
  await coordinator.onEvent(2, { type: "agent_response", run_id: "run_1", text: "Done" });
  appendEvent(sql, 3, { type: "agent_run_completed", run_id: "run_1" });
  await coordinator.onEvent(3, { type: "agent_run_completed", run_id: "run_1" });

  // Response delivered, delete exhausted retries: row survives with a retry.
  assert.equal(sql.getRow("run_1").card_delete_pending_at !== null, true);
  assert.ok(sql.getRow("run_1").next_retry_at > Date.now());
  assert.ok(alarms.length > 0);

  await coordinator.drainDue(Date.now() + 10_000);
  assert.equal(calls.filter((call) => call.method === "chat.delete").length, 4);
  assert.equal(sql.getRow("run_1"), undefined);
});

test("treats a 404 card delete as already-done and cleans up", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const coordinator = createCoordinator(sql, calls, async () => {}, async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.delete") return { ok: false, error: "message_not_found", status: 404 };
    if (method === "chat.postMessage") return { ok: true, data: { ts: "card_1" } };
    return { ok: true, data: { ok: true } };
  });

  appendEvent(sql, 1, started);
  await coordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_run_completed", run_id: "run_1" });
  await coordinator.onEvent(2, { type: "agent_run_completed", run_id: "run_1" });

  assert.equal(calls.filter((call) => call.method === "chat.delete").length, 1);
  assert.equal(sql.getRow("run_1"), undefined);
});

test("replays a pending card teardown after coordinator restart", async () => {
  const originalNow = Date.now;
  Date.now = () => 200_000;
  try {
    const sql = createPresentationSql();
    const calls = [];
    const alarms = [];
    let deleteAttempts = 0;
    const api = async (_token, method, body) => {
      calls.push({ method, body });
      if (method === "chat.delete" && deleteAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
      if (method === "chat.postMessage") return { ok: true, data: { ts: "message_1" } };
      return { ok: true, data: { ok: true } };
    };
    const firstCoordinator = createCoordinator(sql, calls, async () => {}, api, alarms);
    appendEvent(sql, 1, started);
    await firstCoordinator.onEvent(1, started);
    appendEvent(sql, 2, { type: "agent_run_completed", run_id: "run_1" });
    await firstCoordinator.onEvent(2, { type: "agent_run_completed", run_id: "run_1" });
    assert.ok(sql.getRow("run_1").next_retry_at !== null);
    assert.ok(alarms.length > 0);

    const restartedCoordinator = createCoordinator(sql, calls, async () => {}, api, alarms);
    await restartedCoordinator.drainDue(210_000);
    assert.equal(calls.filter((call) => call.method === "chat.delete").length, 4);
    assert.equal(sql.getRow("run_1"), undefined);
  } finally {
    Date.now = originalNow;
  }
});

test("queued turns surface live progress after they start, each card resolves independently", async () => {
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

  // Cards posted for all three turns before any run starts.
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 3);

  await append({ type: "agent_run_completed", run_id: "run_1" }, "run_1");
  await append(startedR(2, "Second task"), "run_2");
  await append({ type: "status", message: "Running tests" }, "run_2");
  await append({ type: "agent_event", event: { type: "tool_execution_start", tool: "edit", toolCallId: "c2", args: { file_path: "src/a.ts" } } }, "run_2");
  await coordinator.drainDue(Date.now() + 3_000);

  // Run 2's card now shows live progress (not stale queue state) and the
  // title of its own request.
  const cardUpdates = calls.filter((call) => call.method === "chat.update");
  const run2Updates = cardUpdates.filter((call) => JSON.stringify(call.body).includes("Second task"));
  const run2LiveUpdate = run2Updates.at(-1);
  assert.ok(run2LiveUpdate, "run 2 card should have a live update");
  assert.match(JSON.stringify(run2LiveUpdate.body), /Editing code/);
  assert.match(JSON.stringify(run2LiveUpdate.body), /login\.ts|a\.ts/);
  assert.doesNotMatch(JSON.stringify(run2LiveUpdate.body), /In queue/);
  assert.doesNotMatch(JSON.stringify(run2LiveUpdate.body), /First task/);

  await append({ type: "agent_response", run_id: "run_2", text: "Second done" }, "run_2");
  await append({ type: "agent_run_completed", run_id: "run_2" }, "run_2");

  assert.equal(calls.filter((call) => call.method === "chat.delete").length, 2);
  assert.equal(sql.getRow("run_1"), undefined);
  assert.equal(sql.getRow("run_2"), undefined);
  assert.notEqual(sql.getRow("run_3"), undefined);
  assert.equal(sql.getRow("run_3").card_delete_pending_at, null);
});

test("never folds another run's live progress into a queued card", async () => {
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
  // run_2 queued while run_1 executes...
  await append(req(2, "Second task"), "run_1");
  await append(queued(2, 1), "run_1");
  // ...and run_1 keeps producing global progress after run_2 was queued.
  await append({ type: "status", message: "Running tests" }, "run_1");
  await append({ type: "agent_event", event: { type: "tool_execution_start", tool: "read", toolCallId: "c1", args: { file_path: "src/lib.ts" } } }, "run_1");
  await coordinator.drainDue(Date.now() + 3_000);

  const run2Updates = calls.filter((call) => call.method === "chat.update" && JSON.stringify(call.body).includes("Second task"));
  const run2Card = run2Updates.at(-1);
  assert.ok(run2Card, "run 2 should have a queued card update");
  assert.match(JSON.stringify(run2Card.body), /In queue \(position 1\)/);
  assert.doesNotMatch(JSON.stringify(run2Card.body), /Verifying|Investigating|Reading files|lib\.ts/);
});

test("teardown stays scheduled across a restart mid-delete", async () => {
  const sql = createPresentationSql();
  const calls = [];
  const alarms = [];
  let deleteAttempts = 0;
  const api = async (_token, method, body) => {
    calls.push({ method, body });
    if (method === "chat.delete" && deleteAttempts++ < 3) return { ok: false, error: "http_503", status: 503 };
    if (method === "chat.postMessage") return { ok: true, data: { ts: "card_1" } };
    return { ok: true, data: { ok: true } };
  };
  const firstCoordinator = createCoordinator(sql, calls, async () => {}, api, alarms);
  appendEvent(sql, 1, started);
  await firstCoordinator.onEvent(1, started);
  appendEvent(sql, 2, { type: "agent_response", run_id: "run_1", text: "Done" });
  await firstCoordinator.onEvent(2, { type: "agent_response", run_id: "run_1", text: "Done" });
  appendEvent(sql, 3, { type: "agent_run_completed", run_id: "run_1" });
  await firstCoordinator.onEvent(3, { type: "agent_run_completed", run_id: "run_1" });

  // Response delivered; delete failing but the row stays scheduled (due
  // immediately at teardown, re-armed on exhaustion), so even a hard restart
  // cannot strand the card.
  const row = sql.getRow("run_1");
  assert.equal(row.pending_final_response_cursor, null);
  assert.notEqual(row.card_delete_pending_at, null);
  assert.ok(row.next_retry_at !== null);
  assert.ok(alarms.length > 0);

  const restartedCoordinator = createCoordinator(sql, calls, async () => {}, api, alarms);
  const retryAt = restartedCoordinator.nextRetryAt();
  assert.ok(retryAt !== null);
  await restartedCoordinator.drainDue(Date.now() + 10_000);
  assert.equal(sql.getRow("run_1"), undefined);
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
