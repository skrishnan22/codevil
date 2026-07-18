# Slack Rich Messages and Question Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render agent Markdown correctly in Slack and let any human participant in a linked Slack conversation answer option-based Codevil questions in Slack.

**Architecture:** Replace the regex Markdown conversion with structured Slack message payloads containing native `markdown` blocks. Extend provider-neutral question intents with the existing question metadata, render Block Kit controls, validate signed `block_actions` against the stored Slack conversation link, and submit the answer through a dedicated Durable Object method that reuses the existing question transition. Keep Slack user IDs canonical, resolve display names through `users.info`, and let the first valid answer win.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, D1, Zod, Slack Web API and Block Kit, Node test runner, pnpm.

---

## Scope and sequencing

The work is split into seven independently testable slices:

1. Structured Slack payloads and native Markdown rendering.
2. Safe splitting of responses beyond Slack's Markdown-block limit.
3. Provider-neutral question data and Slack question controls.
4. Signed Block Kit interaction parsing, manifest configuration, and HTTP routing.
5. A validated integration-facing question-answer transition in the Session orchestrator.
6. End-to-end Slack action processing, user attribution, stale-state updates, and errors.
7. Documentation and full verification.

Do not add Slack modals, free-form Slack inputs, account linking, or Slack plan-approval controls.

## File structure

### Slack rendering and delivery

- Modify `packages/worker/src/integrations/slack/client.ts`
  - Define the minimal structured message/block types used by Codevil.
  - Send `blocks` through `chat.postMessage`.
  - Add `chat.update`, `chat.postEphemeral`, and `users.info` helpers.
- Modify `packages/worker/src/integrations/slack/render.ts`
  - Return one or more structured message payloads.
  - Use native `markdown` blocks for agent responses.
  - Build question controls and answered-state blocks.
  - Produce useful plain-text fallbacks.
- Modify `packages/worker/src/integrations/notification-intents.ts`
  - Preserve all option/question metadata from `question_raised`.
- Modify `packages/worker/src/integrations/notify-external-conversation.ts`
  - Deliver every rendered message chunk in order.

### Slack interactions

- Create `packages/worker/src/integrations/slack/actions.ts`
  - Define Zod schemas for `block_actions` payloads.
  - Decode Codevil action values and selected option ordinals.
  - Resolve Slack display names.
  - Validate the stored Slack conversation link.
  - Submit answers and update or annotate the Slack message.
- Modify `packages/worker/src/integrations/slack/routes.ts`
  - Verify signatures, parse form-encoded interaction payloads, and acknowledge valid actions promptly.
- Modify `packages/worker/src/integrations/slack/manifest.ts`
  - Enable interactivity at `/slack/actions`.
- Modify `packages/worker/src/http-router.ts`
  - Route `/slack/actions` before origin-guarded application routes.
- Modify `packages/worker/src/index.ts`
  - Pass `ExecutionContext.waitUntil` into routing so action processing can continue after acknowledgement.

### Session question transition

- Create `packages/worker/src/orchestrator/question-answer.ts`
  - Load complete question answer state.
  - Validate option IDs/cardinality.
  - Apply one answer and return a structured result.
- Modify `packages/worker/src/orchestrator/questions-store.ts`
  - Add a complete answer-state row loader and JSON parsers.
- Modify `packages/worker/src/orchestrator/cli-handlers.ts`
  - Reuse the extracted answer transition for web/CLI answers.
- Modify `packages/worker/src/orchestrator.ts`
  - Add `answerQuestionFromIntegration` for Slack-originated answers.

### Tests and docs

- Modify `packages/worker/test/slack-render.test.mjs`
- Modify `packages/worker/test/slack-client.test.mjs`
- Modify `packages/worker/test/external-notifications.test.mjs`
- Modify `packages/worker/test/slack-manifest.test.mjs`
- Modify `packages/worker/test/slack-routes.test.mjs`
- Modify `packages/worker/test/http-router.test.mjs`
- Create `packages/worker/test/slack-actions.test.mjs`
- Create `packages/worker/test/question-answer.test.mjs`
- Modify `packages/worker/test/helpers/fake-host.mjs`
- Modify `README.md`

## Task 1: Structured messages and native Markdown blocks

**Files:**

- Modify: `packages/worker/test/slack-client.test.mjs`
- Modify: `packages/worker/test/slack-render.test.mjs`
- Modify: `packages/worker/src/integrations/slack/client.ts`
- Modify: `packages/worker/src/integrations/slack/render.ts`

- [ ] **Step 1: Write failing client and renderer tests**

Replace the existing string-only renderer expectation with structural assertions:

```js
test("agent responses use Slack's native markdown block", () => {
  assert.deepEqual(
    renderSlackNotification({
      type: "agent_response",
      runId: "run_1",
      text: "## Result\n\n| Spec | Value |\n|---|---|\n| PR | *https://github.com/acme/app/pull/45* |",
    }, sessionUrl),
    [{
      text: "Result — Spec: Value; PR: https://github.com/acme/app/pull/45",
      blocks: [{
        type: "markdown",
        text: "## Result\n\n| Spec | Value |\n|---|---|\n| PR | *https://github.com/acme/app/pull/45* |",
      }],
    }],
  );
});

test("postSlackMessage forwards blocks and thread timestamp", async () => {
  const calls = [];
  await postSlackMessage(
    async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, data: { ok: true, ts: "171951.0002" } };
    },
    "xoxb-test",
    {
      channel: "C123",
      threadTs: "171951.0001",
      text: "Result",
      blocks: [{ type: "markdown", text: "**Result**" }],
    },
  );

  assert.deepEqual(calls[0].body, {
    channel: "C123",
    thread_ts: "171951.0001",
    text: "Result",
    blocks: [{ type: "markdown", text: "**Result**" }],
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-render.test.mjs packages/worker/test/slack-client.test.mjs
```

Expected: FAIL because `renderSlackNotification` returns a string and `SlackMessageInput` does not accept `blocks`.

- [ ] **Step 3: Add structured Slack message types and payload forwarding**

In `client.ts`, introduce minimal provider-owned types rather than a Slack SDK dependency:

```ts
export type SlackBlock = Record<string, unknown> & { type: string };

export interface SlackMessageContent {
  text: string;
  blocks?: SlackBlock[];
}

export interface SlackMessageInput extends SlackMessageContent {
  channel: string;
  threadTs?: string;
}

export interface SlackPostedMessage {
  ok: true;
  ts: string;
  channel?: string;
}
```

Update `postSlackMessage` to include `blocks` only when present and return `SlackApiResult<SlackPostedMessage>`.

- [ ] **Step 4: Replace regex conversion with native Markdown rendering**

Change the renderer signature to:

```ts
export function renderSlackNotification(
  intent: ExternalNotificationIntent,
  sessionUrl: string,
): SlackMessageContent[];
```

For `agent_response`, normalize CRLF and outer whitespace only, then return:

```ts
return [{
  text: markdownFallback(intent.text),
  blocks: [{ type: "markdown", text: normalized }],
}];
```

Implement `markdownFallback` as a bounded, single-line notification summary:

1. Convert Markdown links to their visible labels unless the label is empty.
2. Convert table separator rows such as `|---|:---:|` to nothing.
3. Convert remaining table rows to semicolon-separated `key: value` text.
4. Strip heading markers, emphasis markers, backticks, block-quote markers, and list prefixes.
5. Collapse whitespace and bound the result to 500 characters.

Delete `renderSlackMrkdwn`; no regex path may rewrite the visible Markdown block.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit the slice**

```bash
git add packages/worker/src/integrations/slack/client.ts packages/worker/src/integrations/slack/render.ts packages/worker/test/slack-client.test.mjs packages/worker/test/slack-render.test.mjs
git commit -m "fix(worker): render Slack replies with native markdown blocks"
```

## Task 2: Split long Markdown responses without clipping

**Files:**

- Modify: `packages/worker/test/slack-render.test.mjs`
- Modify: `packages/worker/test/external-notifications.test.mjs`
- Modify: `packages/worker/src/integrations/slack/render.ts`
- Modify: `packages/worker/src/integrations/notify-external-conversation.ts`

- [ ] **Step 1: Write failing chunking tests**

Add tests that prove a response over 12,000 characters becomes multiple payloads and code fences remain balanced:

```js
test("long Markdown is split into balanced native Markdown blocks", () => {
  const source = `# Report\n\n\`\`\`ts\n${"const x = 1;\n".repeat(1_000)}\`\`\``;
  const rendered = renderSlackNotification({
    type: "agent_response",
    runId: "run_1",
    text: source,
  }, sessionUrl);

  assert.ok(rendered.length > 1);
  for (const message of rendered) {
    assert.ok(message.blocks[0].text.length <= 11_500);
    assert.equal((message.blocks[0].text.match(/```/g) ?? []).length % 2, 0);
  }
  assert.match(rendered[1].blocks[0].text, /^```ts\n/);
});

test("external notification delivery posts every rendered chunk in order", async () => {
  // Use the existing fake D1 destination and collect chat.postMessage bodies.
  // Supply an agent_response larger than 12,000 characters.
  // Assert calls.length > 1 and every call retains the same channel/thread_ts.
});
```

In the second test, use the same fake D1 setup already present in `external-notifications.test.mjs`; assert the concatenated block text contains both the first and last unique markers from the source.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-render.test.mjs packages/worker/test/external-notifications.test.mjs
```

Expected: FAIL because the renderer creates one over-limit block and delivery posts once.

- [ ] **Step 3: Implement fence-aware Markdown chunking**

Add `MAX_SLACK_MARKDOWN_CHARS = 11_500` and a pure `splitSlackMarkdown` helper. It must:

- split on newline boundaries whenever possible;
- track whether a line beginning with three backticks opens or closes a fence;
- close an open fence before ending a chunk;
- reopen the fence, including its language tag, at the start of the next chunk;
- hard-split a single over-limit line only when no newline boundary exists;
- never return an empty chunk.

Use the helper before building `markdown` blocks. Build a fallback from each chunk so Slack notifications remain meaningful.

- [ ] **Step 4: Deliver all chunks sequentially**

In `notifyExternalConversation`, render once and loop in order:

```ts
const messages = renderSlackNotification(intent, sessionUrl);
for (const message of messages) {
  const result = await postSlackMessage(api, input.env.SLACK_BOT_TOKEN, {
    channel: destination.external_channel_id,
    threadTs: destination.external_conversation_id,
    ...message,
  });
  if (!result.ok) {
    logSlackDeliveryFailure(result.error);
    break;
  }
}
```

Keep the existing durable cursor claim around the whole logical notification. Stop after the first Slack failure so later chunks cannot arrive out of order.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit the slice**

```bash
git add packages/worker/src/integrations/slack/render.ts packages/worker/src/integrations/notify-external-conversation.ts packages/worker/test/slack-render.test.mjs packages/worker/test/external-notifications.test.mjs
git commit -m "fix(worker): split long Slack markdown replies safely"
```

## Task 3: Render option-based questions with Block Kit controls

**Files:**

- Modify: `packages/worker/test/external-notifications.test.mjs`
- Modify: `packages/worker/test/slack-render.test.mjs`
- Modify: `packages/worker/src/integrations/notification-intents.ts`
- Modify: `packages/worker/src/integrations/slack/render.ts`

- [ ] **Step 1: Write failing intent-mapping tests**

Update the existing `question_raised` assertion to require all interaction data:

```js
assert.deepEqual(externalNotificationIntent({
  type: "question_raised",
  request_id: "question_1",
  run_id: "run_1",
  question: "Which database?",
  context: "Choose the deployment store.",
  options: [
    { id: "pg", label: "PostgreSQL", detail: "Managed production database" },
    { id: "sqlite", label: "SQLite" },
  ],
  allow_freeform: false,
  allow_multiple: false,
  answerable_by: "decider",
  status: "open",
  raised_at: "2026-07-12T00:00:00.000Z",
}), {
  type: "question_asked",
  requestId: "question_1",
  runId: "run_1",
  question: "Which database?",
  context: "Choose the deployment store.",
  options: [
    { id: "pg", label: "PostgreSQL", detail: "Managed production database" },
    { id: "sqlite", label: "SQLite" },
  ],
  allowFreeform: false,
  allowMultiple: false,
});
```

- [ ] **Step 2: Write failing rendering tests for every control variant**

Cover these exact shapes in `slack-render.test.mjs`:

- two single-choice options produce two `button` elements with `action_id: "codevil_question_answer"` plus an **Open session** URL button;
- six single-choice options produce a `static_select` and `codevil_question_submit` button;
- up to ten multiple-choice options produce `checkboxes` and a submit button;
- eleven multiple-choice options produce `multi_static_select` and a submit button;
- more than one hundred options produce only **Open session**;
- a free-form-only question produces only **Open session**;
- long labels are fully shown in Markdown and safely truncated in controls;
- `renderAnsweredSlackQuestion` removes answer controls and includes `Answered by <@U123>`.

Action values must carry the request ID and option ordinal, never the unbounded option ID. Use this JSON form for direct buttons:

```json
{"v":1,"q":"question_1","i":0}
```

Select and checkbox option values are ordinal strings (`"0"`, `"1"`). The submit button carries:

```json
{"v":1,"q":"question_1"}
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-render.test.mjs packages/worker/test/external-notifications.test.mjs
```

Expected: FAIL because question metadata is discarded and no blocks exist.

- [ ] **Step 4: Preserve question metadata in the intent**

Change the union member to:

```ts
| {
    type: "question_asked";
    requestId: string;
    runId: string;
    question: string;
    context?: string;
    options?: QuestionOption[];
    allowFreeform: boolean;
    allowMultiple: boolean;
  }
```

Map these fields directly from `question_raised`. Do not carry `answerable_by` into the Slack renderer because the approved Slack policy allows any human participant to answer.

- [ ] **Step 5: Implement question rendering and action-token encoding**

In `render.ts`, export:

```ts
export function encodeSlackQuestionAction(input: {
  requestId: string;
  optionIndex?: number;
}): string | null;

export function renderAnsweredSlackQuestion(input: {
  question: string;
  selectedLabels: string[];
  answeredByText: string;
  sessionUrl: string;
}): SlackMessageContent;
```

`encodeSlackQuestionAction` returns `null` when the JSON exceeds Slack's button value limit; the renderer then emits only **Open session**. Build full option descriptions into a native Markdown block, but control text must be bounded to Slack's 75-character option/button limit.

Use these thresholds exactly:

- single choice: buttons for 1–5, static select for 6–100;
- multiple choice: checkboxes for 1–10, multi-select for 11–100;
- no options or more than 100: no answer control;
- always include **Open session**.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 7: Commit the slice**

```bash
git add packages/worker/src/integrations/notification-intents.ts packages/worker/src/integrations/slack/render.ts packages/worker/test/external-notifications.test.mjs packages/worker/test/slack-render.test.mjs
git commit -m "feat(worker): render Slack question controls"
```

## Task 4: Parse and acknowledge signed Slack interactions

**Files:**

- Create: `packages/worker/src/integrations/slack/actions.ts`
- Create: `packages/worker/test/slack-actions.test.mjs`
- Modify: `packages/worker/src/integrations/slack/routes.ts`
- Modify: `packages/worker/src/integrations/slack/manifest.ts`
- Modify: `packages/worker/src/http-router.ts`
- Modify: `packages/worker/src/index.ts`
- Modify: `packages/worker/test/slack-manifest.test.mjs`
- Modify: `packages/worker/test/slack-routes.test.mjs`
- Modify: `packages/worker/test/http-router.test.mjs`

- [ ] **Step 1: Write failing pure parser tests**

Create `slack-actions.test.mjs` with fixtures for:

- a direct option button;
- static-select state plus submit;
- checkbox state plus submit;
- multi-select state plus submit;
- missing team/user/channel/message/action data;
- malformed JSON action values;
- negative, duplicate, and non-integer ordinals.

Assert the successful parser result has this provider-owned shape:

```js
{
  teamId: "T123",
  userId: "U123",
  channelId: "C123",
  messageTs: "171951.0002",
  threadTs: "171951.0001",
  requestId: "question_1",
  optionIndexes: [0, 2],
  actionTs: "171951.1111",
}
```

- [ ] **Step 2: Write failing manifest and route tests**

Change the manifest expectation from disabled to:

```js
assert.match(manifest, /interactivity:\n\s+is_enabled: true/);
assert.match(manifest, /request_url: https:\/\/worker\.example\.com\/slack\/actions/);
```

Add route tests proving:

- invalid signatures return 401 and schedule no work;
- missing `payload` form field returns 400;
- malformed payload returns 400;
- a valid signed `block_actions` form returns 200 immediately and passes one promise to injected `waitUntil`;
- `/slack/actions` is routed before the trusted-origin guard.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-manifest.test.mjs packages/worker/test/slack-routes.test.mjs packages/worker/test/http-router.test.mjs
```

Expected: FAIL because the parser, endpoint, and manifest configuration do not exist.

- [ ] **Step 4: Implement strict payload parsing**

In `actions.ts`, define a narrow Zod schema for `block_actions` with required team, user, channel, message/container timestamps, action timestamps, action IDs, and state. Export:

```ts
export type SlackQuestionAction = {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requestId: string;
  optionIndexes: number[];
  actionTs: string;
};

export function parseSlackQuestionAction(payload: unknown): SlackQuestionAction | null;
```

Only accept Codevil's three answer action IDs. Deduplicate and sort ordinals. Reject an empty selection, unsafe integer, missing request ID, or unsupported action.

- [ ] **Step 5: Enable interactivity and add the signed route**

Generate:

```yaml
interactivity:
  is_enabled: true
  request_url: <origin>/slack/actions
```

Add `handleSlackAction` to `routes.ts`. It must read the raw form body, verify the existing Slack HMAC before parsing, extract and JSON-parse the `payload` field, call `parseSlackQuestionAction`, then schedule the injected processor with `waitUntil` and return `{ ok: true }`.

Extend route dependencies with:

```ts
export interface SlackActionDeps {
  slackApi?: SlackApi;
  waitUntil?: (promise: Promise<unknown>) => void;
  processAction?: typeof processSlackQuestionAction;
}
```

Tests inject `processAction`; production uses the implementation added in Task 6.

- [ ] **Step 6: Thread `waitUntil` through the Worker router**

Change the Worker handler to receive `ctx`:

```ts
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
```

Pass `waitUntil: (promise) => ctx.waitUntil(promise)` through `dispatchHttpRequest` only for `/slack/actions`. Existing tests without a context continue using an injected no-op or promise collector.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 8: Commit the slice**

```bash
git add packages/worker/src/integrations/slack/actions.ts packages/worker/src/integrations/slack/routes.ts packages/worker/src/integrations/slack/manifest.ts packages/worker/src/http-router.ts packages/worker/src/index.ts packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-manifest.test.mjs packages/worker/test/slack-routes.test.mjs packages/worker/test/http-router.test.mjs
git commit -m "feat(worker): accept signed Slack block actions"
```

## Task 5: Add the integration-facing question-answer transition

**Files:**

- Create: `packages/worker/src/orchestrator/question-answer.ts`
- Create: `packages/worker/test/question-answer.test.mjs`
- Modify: `packages/worker/src/orchestrator/questions-store.ts`
- Modify: `packages/worker/src/orchestrator/cli-handlers.ts`
- Modify: `packages/worker/src/orchestrator.ts`
- Modify: `packages/worker/test/helpers/fake-host.mjs`
- Modify: `packages/worker/test/cli-handlers.test.mjs`

- [ ] **Step 1: Write failing answer-transition tests**

Build question rows in `question-answer.test.mjs` with `options_json`, `allow_multiple`, `answer_json`, and answerer fields. Cover:

- ordinal `0` maps to the first stored option ID and emits one `question_answered` plus one `ask_question_response`;
- multiple ordinals are rejected when `allow_multiple` is false;
- duplicate, negative, and out-of-range ordinals are rejected;
- an open question with no options is rejected for a Slack option answer;
- the first accepted answer changes status to `answered`;
- the same retry returns the existing accepted state without emitting another event;
- a different later answer returns `already_answered` and preserves the first answer;
- a cancelled or missing question returns `not_open`;
- web/CLI `handleQuestionAnswer` still enforces its existing authorization before using the shared transition.

Use this result union:

```ts
export type IntegrationQuestionAnswerResult =
  | {
      ok: true;
      status: "answered" | "already_answered";
      question: string;
      selectedLabels: string[];
      answeredBy: ParticipantIdentity;
    }
  | {
      ok: false;
      status: "not_found" | "not_open" | "invalid_selection";
      error: string;
    };
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/question-answer.test.mjs packages/worker/test/cli-handlers.test.mjs
```

Expected: FAIL because the reusable transition and public Durable Object method do not exist.

- [ ] **Step 3: Add a complete answer-state row loader**

In `questions-store.ts`, add a local Zod schema and loader for:

```text
request_id, question, status, options_json, allow_multiple,
answer_json, answered_by_id, answered_by_name
```

Parse `options_json` with `z.array(QuestionOptionSchema)` and parse `answer_json` with an object schema containing `option_ids` and optional `freeform`. Invalid stored JSON returns a safe `invalid_selection` result and emits the existing validation-drop telemetry; it must not throw.

- [ ] **Step 4: Extract and reuse the answer mutation**

In `question-answer.ts`, implement one mutation function that:

1. Loads the question.
2. Returns the existing accepted answer if status is `answered`.
3. Requires status `open`.
4. Maps validated ordinals to stored option IDs for Slack, or accepts already-validated option IDs from web/CLI.
5. Enforces non-empty selection and `allow_multiple`.
6. Updates the question row to `answered`.
7. Broadcasts `question_answered` once.
8. Sends `ask_question_response` to the sandbox once.
9. Returns selected labels and the answerer.

Refactor `handleQuestionAnswer` to retain its `canAnswerQuestion` check and then call the shared mutation with web/CLI option IDs. Preserve current user-facing error events.

- [ ] **Step 5: Add the public Durable Object method**

Add to `Orchestrator`:

```ts
answerQuestionFromIntegration(args: {
  requestId: string;
  optionIndexes: number[];
  actor: ParticipantIdentity;
  idempotencyKey: string;
}): IntegrationQuestionAnswerResult {
  this.loadMeta();
  if (!this.meta) {
    return { ok: false, status: "not_open", error: "Session not initialized" };
  }
  return answerQuestionFromIntegration(this, args);
}
```

This method intentionally bypasses `answerable_by` for the approved Slack trust model, but it does not bypass question existence, open-state, option, or cardinality validation. The Durable Object's serialized execution plus persisted answered status provides first-valid-answer-wins behavior.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 7: Commit the slice**

```bash
git add packages/worker/src/orchestrator/question-answer.ts packages/worker/src/orchestrator/questions-store.ts packages/worker/src/orchestrator/cli-handlers.ts packages/worker/src/orchestrator.ts packages/worker/test/question-answer.test.mjs packages/worker/test/helpers/fake-host.mjs packages/worker/test/cli-handlers.test.mjs
git commit -m "feat(worker): answer questions through integration boundary"
```

## Task 6: Process Slack answers and update question messages

**Files:**

- Modify: `packages/worker/src/integrations/slack/actions.ts`
- Modify: `packages/worker/src/integrations/slack/client.ts`
- Modify: `packages/worker/src/integrations/slack/routes.ts`
- Modify: `packages/worker/src/integrations/store.ts`
- Modify: `packages/worker/test/slack-actions.test.mjs`
- Modify: `packages/worker/test/slack-client.test.mjs`
- Modify: `packages/worker/test/slack-routes.test.mjs`

- [ ] **Step 1: Write failing Slack client helper tests**

Add exact payload assertions for:

```ts
updateSlackMessage(api, token, {
  channel: "C123",
  ts: "171951.0002",
  text: "Answered",
  blocks: [...],
});

postSlackEphemeral(api, token, {
  channel: "C123",
  user: "U123",
  text: "This question was already answered.",
});

fetchSlackUser(api, token, "U123");
```

Assert methods `chat.update`, `chat.postEphemeral`, and `users.info` receive Slack's snake_case fields.

- [ ] **Step 2: Write failing action-service tests**

Use injected D1, Slack API, and orchestrator stubs. Cover:

- a matching team/channel/thread link invokes `answerQuestionFromIntegration` with `external:slack:U123`;
- the idempotency key is the deterministic tuple `team:user:channel:message:action_ts:request`;
- `users.info` prefers `profile.display_name`, then `real_name`, then user ID;
- the external actor row is upserted with the resolved display name;
- a successful answer calls `chat.update` with no active answer controls and `Answered by <@U123>`;
- `already_answered` by another Slack user derives `<@USER_ID>` from an `external:slack:USER_ID` participant ID;
- `already_answered` by a web participant uses the stored plain display name instead of producing an invalid Slack mention;
- either `is_bot` or `is_app_user` from `users.info` prevents answer submission;
- missing conversation links, bot users, invalid selections, and wrong Sessions never mutate the orchestrator;
- profile lookup failure falls back to `U123` and still answers;
- orchestrator failure leaves controls unchanged and sends an ephemeral retry message;
- `chat.update` failure is logged but does not invoke the orchestrator twice.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
pnpm --filter @codevil/worker run build && node --test packages/worker/test/slack-client.test.mjs packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-routes.test.mjs
```

Expected: FAIL because the client helpers and processor behavior do not exist.

- [ ] **Step 4: Add Slack API helpers and display-name resolution**

Implement typed wrappers in `client.ts` for the three methods from Step 1. In `actions.ts`, resolve a name using:

```ts
const displayName =
  user.profile?.display_name?.trim()
  || user.real_name?.trim()
  || user.name?.trim()
  || slackUserId;
```

Never use the resolved name as an identity key. Render Slack-visible attribution with `<@${slackUserId}>` so Slack displays the current name.

- [ ] **Step 5: Add a store query that validates the action destination**

Reuse `externalSessionLinkSelect(integrationId("slack", teamId), channelId, threadTs)` for the primary lookup. Add a helper only if the actual interaction fixture proves Slack omits `thread_ts`; that helper must join `external_session_links` to integrations and match team, channel, and message root. Do not accept a Session ID from the action value.

- [ ] **Step 6: Implement `processSlackQuestionAction`**

Export:

```ts
export async function processSlackQuestionAction(
  action: SlackQuestionAction,
  env: Pick<Env, "DB" | "ORCHESTRATOR" | "SLACK_BOT_TOKEN" | "CODEVIL_SLACK_BOT_USER_ID">,
  deps: { slackApi?: SlackApi } = {},
): Promise<void>;
```

Processing order:

1. Reject the configured bot user.
2. Resolve the stored external Session link using team, channel, and thread.
3. Resolve the Slack profile, reject `is_bot` or `is_app_user`, and otherwise fall back to the user ID for a missing display name.
4. Upsert `integration_external_actors` with the resolved human display name.
5. Call the linked Session's `answerQuestionFromIntegration` with ordinals and canonical external actor.
6. On `answered`, call `chat.update` with `renderAnsweredSlackQuestion` and `<@${action.userId}>` attribution.
7. On `already_answered`, update from the returned accepted state and send an ephemeral stale notice. Format an accepted `external:slack:USER_ID` actor as `<@USER_ID>`; escape and display any non-Slack actor's stored name as plain text.
8. On validation/not-open failure, send a safe ephemeral message and leave controls unchanged unless accepted state is available.
9. Log API failures using IDs and Slack error codes only; never log raw interaction payloads or tokens.

- [ ] **Step 7: Wire the real processor into the acknowledged route**

After synchronous signature/schema validation, schedule:

```ts
waitUntil(processSlackQuestionAction(action, env, { slackApi }));
return json({ ok: true }, 200);
```

If no injected `waitUntil` exists in a unit test, await the processor before returning. Production always supplies `ExecutionContext.waitUntil`.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 9: Commit the slice**

```bash
git add packages/worker/src/integrations/slack/actions.ts packages/worker/src/integrations/slack/client.ts packages/worker/src/integrations/slack/routes.ts packages/worker/src/integrations/store.ts packages/worker/test/slack-actions.test.mjs packages/worker/test/slack-client.test.mjs packages/worker/test/slack-routes.test.mjs
git commit -m "feat(worker): submit and reflect Slack question answers"
```

## Task 7: Documentation and complete verification

**Files:**

- Modify: `README.md`
- Modify: any test file from Tasks 1–6 only when full-suite evidence exposes a regression

- [ ] **Step 1: Update Slack setup and behavior documentation**

In the README Slack section:

- state that the generated manifest enables `/slack/actions` interactivity;
- state that agent replies use native Slack Markdown Blocks, including tables and fenced code;
- explain single-choice buttons and multiple-choice checkboxes/selects;
- state that any human in the linked Slack conversation may answer;
- state that the first accepted answer wins;
- state that free-form answers, plan approvals, and account linking still open the Codevil session;
- tell existing operators to regenerate/update their Slack app manifest before expecting buttons to work.

- [ ] **Step 2: Run the complete Worker suite**

```bash
pnpm --filter @codevil/worker test
```

Expected: all Worker tests PASS with no warnings or unhandled rejections.

- [ ] **Step 3: Run repository type and formatting gates**

```bash
pnpm typecheck
pnpm format:check
```

Expected: both commands PASS.

- [ ] **Step 4: Run the repository verification gate**

```bash
pnpm verify
```

Expected: PASS. If only sandbox preview tests fail with a local-listener `EPERM`, record that exact environment limitation and run every non-preview package gate separately; do not label it a product regression without reproduction outside the restricted harness.

- [ ] **Step 5: Inspect the final diff and scope**

```bash
git status --short
git diff --check
git diff --stat HEAD~6..HEAD
```

Expected: only the Slack integration, question transition, tests, and README are changed; `.pnpm-store/` remains untracked and untouched.

- [ ] **Step 6: Commit documentation or verification-only fixes**

```bash
git add README.md
git commit -m "docs: explain Slack formatting and question actions"
```

Skip this commit only if README was already included in a preceding task commit; do not create an empty commit.
