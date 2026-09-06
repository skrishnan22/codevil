# Slack Expanded Card and Answer Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native Slack task card with a default-expanded container that clearly labels chronological activity state, and collect free-text question answers through a Slack modal.

**Architecture:** Keep run projection unchanged and adapt only Slack rendering. Extend the existing orchestrator integration question boundary to accept validated free-form input and expose the current question copy for modal rendering. Route Slack `block_actions` and `view_submission` payloads through typed parsers and the existing thread-to-session link before opening or submitting the modal.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, Slack Block Kit/Web API, Zod, Node test runner, pnpm.

## Global Constraints

- The live card is one Slack `container` with `is_collapsible: true` and `default_collapsed: false`.
- The container title is the clean public request title with no decorative status emoji.
- Visible activity is oldest-to-newest; the current active activity is the final activity row.
- Activity uses exact status words `Completed`, `Running`, and `Failed` with plain-text glyphs `✓`, `●`, and `×`; the status word is bold.
- Only an active step is labelled `Running`; completed and failed steps cannot be labelled `Running`.
- Keep `MAX_VISIBLE_STEPS`, duplicate collapsing, hidden-step accounting, title redaction, retry, teardown, and link validation behavior.
- Option-only questions remain inline. Questions with `allowFreeform: true` add a `Write answer` button and modal.
- A normal threaded `@Codevil` message remains a new Agent Run request; it is never treated as a question answer.
- The modal uses server-generated versioned `private_metadata`; do not add a D1 migration or persistent question-message mapping.
- Modal submission updates the exact original question message after the answer is accepted.
- Do not modify `.DS_Store` or `PRODUCTION_READINESS.md`.

---

### Task 1: Default-expanded container and explicit chronological activity

**Files:**
- Modify: `packages/worker/src/integrations/slack/render.ts`
- Test: `packages/worker/test/live-run-card.test.mjs`

**Interfaces:**
- Consumes: `ExternalRunPresentation`, `ExternalRunStep`, `MAX_VISIBLE_STEPS`, and `validPullRequestUrl`.
- Produces: `renderSlackRunCard(presentation, sessionUrl, revision)` returning one Slack `container` block with rich-text child blocks.

- [ ] **Step 1: Write failing container and activity tests**

Add assertions equivalent to:

```js
const card = renderSlackRunCard(presentation, sessionUrl, 7).blocks[0];
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
```

Also cover a failed row (`× Failed`) and ensure hidden-step accounting still includes dropped, collapsed, and windowed rows.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/live-run-card.test.mjs
```

Expected: failure because the renderer still emits `task_card`, reverses visible rows, and uses the old one-character markers.

- [ ] **Step 3: Implement the container renderer**

Refactor `renderDetails` to return rich-text sections. Use the following exact row structure:

```ts
function renderStep(step: ExternalRunStep): Record<string, unknown> {
  const state = step.status === "done"
    ? { glyph: "✓", label: "Completed" }
    : step.status === "error"
      ? { glyph: "×", label: "Failed" }
      : { glyph: "●", label: "Running" };
  const detail = step.detail ? ` — ${step.detail}` : "";
  return {
    type: "rich_text_section",
    elements: [
      { type: "text", text: `${state.glyph} ` },
      { type: "text", text: state.label, style: { bold: true } },
      { type: "text", text: ` — ${step.label}${detail}` },
    ],
  };
}
```

Calculate hidden history before adding rows, put `… N earlier step(s)` first, then append `collapsed.steps.slice(-MAX_VISIBLE_STEPS).map(renderStep)` without reversing it.

Emit a container shaped as:

```ts
{
  type: "container",
  block_id: `codevil_run_${presentation.runId}_${revision}`.slice(0, 255),
  title: plainText(presentation.title.slice(0, 120)),
  subtitle: plainText(truncate(briefStatus(presentation), 150)),
  is_collapsible: true,
  default_collapsed: false,
  child_blocks: [activityRichText, sourceLinksRichText],
}
```

Build source links as rich-text `link` elements so `Open Codevil` and the optional validated pull-request URL remain clickable without action callbacks. Omit an empty activity child block. Show terminal summary only in the subtitle.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/live-run-card.test.mjs packages/worker/test/slack-render.test.mjs
```

Expected: both files pass with zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/worker/src/integrations/slack/render.ts packages/worker/test/live-run-card.test.mjs packages/worker/test/slack-render.test.mjs
git commit -m "feat(slack): expand and clarify live run cards"
```

### Task 2: Orchestrator free-form integration boundary

**Files:**
- Modify: `packages/worker/src/orchestrator/question-answer.ts`
- Modify: `packages/worker/src/orchestrator/questions-store.ts`
- Modify: `packages/worker/src/orchestrator.ts`
- Test: `packages/worker/test/question-answer.test.mjs`

**Interfaces:**
- Produces: `answerQuestionFromIntegration(host, { requestId, actor, optionIndexes?, freeform? })`.
- Produces: `freeformQuestionForIntegration(host, requestId)` and Durable Object RPC `freeformQuestionForIntegration({ requestId })` returning open question copy or a typed error.
- Preserves: existing option-index callers and all validation in `applyQuestionAnswer`.

- [ ] **Step 1: Write failing integration-boundary tests**

Add tests equivalent to:

```js
const result = await answer(state.host, {
  requestId: "question_1",
  freeform: "  Use a stronger, shorter headline.  ",
  actor: slackActor,
});
assert.equal(result.ok, true);
assert.deepEqual(result.selectedLabels, ["Use a stronger, shorter headline."]);
assert.equal(state.sandboxMessages[0].freeform, "Use a stronger, shorter headline.");
```

Also prove free-form input is rejected when `allow_freeform` is false and that `freeformQuestionForIntegration` only returns open, free-form-capable questions including their question/context copy.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/question-answer.test.mjs
```

Expected: failure because the integration wrapper requires `optionIndexes` and no question-copy RPC exists.

- [ ] **Step 3: Extend typed question storage and RPCs**

Extend `QuestionAnswerRow` with `context: string | null`, select `context`, and return it from `loadQuestionAnswerRow`.

Use these signatures:

```ts
export interface IntegrationQuestionAnswerInput {
  requestId: string;
  actor: ParticipantIdentity;
  optionIndexes?: number[];
  freeform?: string;
}

export type IntegrationFreeformQuestionResult =
  | { ok: true; question: string; context?: string }
  | { ok: false; status: "not_found" | "not_open" | "freeform_not_allowed"; error: string };
```

Pass both optional answer fields into `applyQuestionAnswer`. `freeformQuestionForIntegration` must load by request ID, require `status === "open"` and `allowFreeform`, and omit `context` when null.

Expose both methods from `Orchestrator` while preserving existing option-action call sites:

```ts
answerQuestionFromIntegration(args: IntegrationQuestionAnswerInput): IntegrationQuestionAnswerResult
freeformQuestionForIntegration(args: { requestId: string }): IntegrationFreeformQuestionResult
```

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/question-answer.test.mjs packages/worker/test/slack-actions.test.mjs
```

Expected: both files pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/worker/src/orchestrator/question-answer.ts packages/worker/src/orchestrator/questions-store.ts packages/worker/src/orchestrator.ts packages/worker/test/question-answer.test.mjs
git commit -m "feat(slack): accept integration free-form answers"
```

### Task 3: Modal payload rendering and typed interaction parsing

**Files:**
- Modify: `packages/worker/src/integrations/slack/render.ts`
- Modify: `packages/worker/src/integrations/slack/actions.ts`
- Test: `packages/worker/test/slack-render.test.mjs`
- Test: `packages/worker/test/slack-actions.test.mjs`

**Interfaces:**
- Produces: `renderSlackFreeformAnswerModal({ question, context, privateMetadata })`.
- Produces: `parseSlackFreeformOpenAction(payload)` and `parseSlackFreeformSubmission(payload)`.
- Produces: versioned modal metadata encoder/parser kept inside `actions.ts`.

- [ ] **Step 1: Write failing rendering and parser tests**

Prove:

```js
const question = renderSlackNotification(questionIntent({ allowFreeform: true }), sessionUrl)[0];
const write = question.blocks
  .find((block) => block.type === "actions")
  .elements.find((element) => element.action_id === "codevil_question_open_freeform");
assert.equal(write.text.text, "Write answer");
assert.equal(write.style, "primary");
```

An option-only question must not contain this action. Add parser fixtures for one valid `block_actions` payload and one valid `view_submission` payload. Assert that malformed metadata, empty input, wrong callback IDs, and missing `trigger_id` return `null`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-render.test.mjs packages/worker/test/slack-actions.test.mjs
```

Expected: failure because the button, modal, and parsers do not exist.

- [ ] **Step 3: Implement exact modal and interaction types**

Use these public shapes:

```ts
export interface SlackFreeformOpenAction {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requestId: string;
  triggerId: string;
}

export interface SlackFreeformSubmission {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requestId: string;
  freeform: string;
}
```

Versioned private metadata is JSON with keys `{ v: 1, q, t, c, th, m }`. Parse it with Zod, require the submission payload's `team.id` to equal metadata key `t`, and cap the encoded value below 3,000 characters. The modal callback ID is `codevil_question_freeform`; the input block/action IDs are `codevil_question_freeform_input` and `codevil_question_freeform_value`.

Render one required multiline `plain_text_input`. Bound question display to 1,000 characters and context display to 1,000 characters before composing their modal sections. Add `Write answer` only when `allowFreeform` is true, using the existing versioned question action encoder for the request ID.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-render.test.mjs packages/worker/test/slack-actions.test.mjs
```

Expected: both files pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/worker/src/integrations/slack/render.ts packages/worker/src/integrations/slack/actions.ts packages/worker/test/slack-render.test.mjs packages/worker/test/slack-actions.test.mjs
git commit -m "feat(slack): render free-form answer modal"
```

### Task 4: Open and submit the modal through the Slack action endpoint

**Files:**
- Modify: `packages/worker/src/integrations/slack/actions.ts`
- Modify: `packages/worker/src/integrations/slack/routes.ts`
- Test: `packages/worker/test/slack-actions.test.mjs`
- Test: `packages/worker/test/slack-routes.test.mjs`

**Interfaces:**
- Consumes: Task 2 orchestrator RPCs and Task 3 modal parsers/renderer.
- Produces: `processSlackFreeformOpenAction` and `processSlackFreeformSubmission`.
- Preserves: existing option actions, non-submitting `Open session`, signed request validation, and app-mention request routing.

- [ ] **Step 1: Write failing open/submission route tests**

Add a valid open-action test that asserts `views.open` receives the original `trigger_id`, rendered question/context, and private metadata containing the exact original message timestamp.

Add a valid submission test that asserts:

```js
assert.deepEqual(answerCalls, [{
  sessionId: "ses_123",
  args: {
    requestId: "question_1",
    freeform: "Use a stronger, shorter headline.",
    actor: { id: "external:slack:U123", name: "krish" },
  },
}]);
assert.equal(updateCall.body.ts, "171951.0002");
assert.match(JSON.stringify(updateCall.body.blocks), /Use a stronger, shorter headline\./);
```

Also prove the signed endpoint closes a valid modal with HTTP 200, schedules processing through `waitUntil`, and does not call `submitAgentRequest`. Add missing-link, bot-user, stale-question, `views.open` failure, and `chat.update` failure coverage.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-routes.test.mjs
```

Expected: failure because the action route only handles option actions.

- [ ] **Step 3: Implement open and submit processors**

For open actions:

1. Resolve `externalSessionLinkSelect(integrationId("slack", teamId), channelId, threadTs)`.
2. Call `freeformQuestionForIntegration({ requestId })` on that session's orchestrator.
3. Encode trusted modal metadata with the resolved Slack coordinates.
4. Call Slack `views.open` with `trigger_id` and the rendered modal.
5. Post an ephemeral failure for missing links, stale questions, or Slack API failure.

For submissions, share the existing human actor resolution/upsert path, then call:

```ts
answerQuestionFromIntegration({
  requestId: submission.requestId,
  freeform: submission.freeform,
  actor,
});
```

On accepted answer, update `submission.messageTs` with `renderAnsweredSlackQuestion`. Keep the answer accepted if `chat.update` fails and log the update failure. Handle `already_answered` consistently with option actions.

Route order after signature/JSON validation must be: non-submitting link actions, free-form open action, free-form submission, existing option action. Construct each processing promise before returning and pass it to `waitUntil` when available. Return an empty HTTP 200 for a recognized `view_submission` so Slack closes the modal.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-routes.test.mjs packages/worker/test/question-answer.test.mjs packages/worker/test/slack-render.test.mjs packages/worker/test/live-run-card.test.mjs
```

Expected: all focused Slack/question tests pass.

- [ ] **Step 5: Run full verification**

```bash
pnpm --filter @codevil/worker test
pnpm --filter @codevil/worker typecheck
git diff --check
```

Expected: 0 test failures, type-check exit 0, and no whitespace errors.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/worker/src/integrations/slack/actions.ts packages/worker/src/integrations/slack/routes.ts packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-routes.test.mjs
git commit -m "feat(slack): handle modal question answers"
```
