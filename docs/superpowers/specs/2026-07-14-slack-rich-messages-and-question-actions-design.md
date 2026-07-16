# Slack Rich Messages and Question Actions Design

**Date:** 2026-07-14
**Status:** Approved for implementation planning

## Goal

Make Codevil responses render correctly in Slack and let Slack participants answer option-based agent questions without leaving the conversation.

The change fixes the current Markdown regressions, including broken tables and visible emphasis markers around GitHub pull-request URLs. It also introduces Slack-native question controls while preserving the Codevil web session as a fallback.

## Scope

This design includes:

- native rendering for standard Markdown in agent responses;
- a plain-text fallback for notifications and clients that do not render blocks;
- Slack controls for single-choice and multiple-choice questions;
- a signed Slack interaction endpoint;
- attribution of accepted answers to the Slack user who submitted them;
- replacement of stale controls after a question is answered;
- tests for rendering, interaction validation, answer submission, races, and failures.

This design does not include:

- Slack modals or inline inputs for free-form answers;
- Slack-to-Codevil account linking;
- Slack-native plan approval or refinement;
- a general-purpose Markdown parser maintained by Codevil.

## Decisions

### Use Slack-native Markdown rendering

Agent responses will be published with a Block Kit `markdown` block containing the original standard Markdown. Slack performs the Markdown translation instead of Codevil converting syntax with regular expressions.

This replaces the current `renderSlackMrkdwn` conversion path for agent responses. It fixes tables, headings, lists, code blocks, emphasis, and links as one coherent behavior. In particular, an emphasized bare GitHub URL no longer leaks literal `*` markers because it is interpreted as standard Markdown by the Markdown block.

Every block-based message also carries a concise, plain-text top-level `text` value. This is the fallback used by push notifications, accessibility surfaces, and clients that cannot render the blocks. The fallback must not contain raw Markdown table delimiters.

The renderer will return structured message content rather than a string:

```ts
interface SlackMessageContent {
  text: string;
  blocks?: SlackBlock[];
}
```

`postSlackMessage` will accept this content together with the destination channel and optional thread timestamp.

### Keep the notification intent provider-neutral

`ExternalNotificationIntent` remains the boundary between Codevil Session events and provider rendering. The `question_asked` intent will retain the question data needed by Slack:

- request ID and run ID;
- question and optional context;
- options with IDs, labels, and details;
- `allow_freeform` and `allow_multiple`;
- the Session URL.

Slack-specific block shapes and action identifiers remain inside the Slack adapter.

## Question Experience

### Single choice

For up to five options, Slack displays one button per option. Clicking an option immediately submits the answer. The question also includes an **Open session** link button.

For six through one hundred options, Slack displays a static select menu and a **Submit answer** button so the message stays readable and remains within Slack's element limits. A question with more than one hundred options falls back to **Open session**.

### Multiple choice

For up to ten options, Slack displays checkboxes and a **Submit answer** button. The submit interaction reads the selected values from the interaction payload's state.

For eleven through one hundred options, Slack displays a multi-select menu and **Submit answer**. A question with more than one hundred options falls back to **Open session**.

### Free-form answers

Free-form-only questions display the question and an **Open session** button. If a question offers both options and an optional free-form note, its options remain answerable in Slack; adding the note requires opening the Codevil session.

### Long labels and details

Codevil question labels are longer than Slack permits in buttons and option objects. Slack controls therefore use a safely truncated control label, while the complete option label and detail are shown in the surrounding Markdown content. Option IDs, not labels, are submitted to Codevil.

## Interaction Flow

1. Codevil posts a question message to the linked Slack thread with a stable action ID and opaque action value.
2. A Slack participant chooses one or more options and submits them.
3. Slack sends a `block_actions` payload to `POST /slack/actions`.
4. Codevil verifies the request timestamp and signature using `SLACK_SIGNING_SECRET` before parsing or acting on the payload.
5. Codevil resolves the integration, Session, channel, thread, and open question using its stored external-conversation link. Session identity from the action value is never trusted without this lookup.
6. Codevil derives a canonical participant ID from the Slack workspace and user IDs, then resolves the user's display name with `users.info` when available.
7. A dedicated integration-facing method on the Session orchestrator submits the existing `question_answer` transition.
8. The Session accepts the first valid answer, broadcasts `question_answered`, and resumes the waiting sandbox request.
9. Codevil updates the original Slack message, removes its active controls, and shows the accepted option labels and answerer.

Slack's stable user ID is the identity key. In Slack-visible confirmation text, Codevil uses `<@USER_ID>` so Slack renders the participant's current display name, such as `@krish`. For Codevil's durable participant name, the adapter prefers `profile.display_name`, then `real_name`, then the Slack user ID. Failure to resolve a profile must not prevent an answer.

## Authorization and Trust Boundary

Any non-bot participant in the linked Slack workspace conversation may answer a Slack-presented question. This is an explicit product decision for the first interactive version.

Consequently, Slack-originated answers do not enforce the web client's `decider` or `assigned` restrictions. They still must satisfy all of these checks:

- valid Slack signature and request timestamp;
- configured Slack workspace integration;
- human Slack actor;
- matching linked channel and thread;
- matching Session and open question;
- option IDs that belong to that question;
- selection cardinality compatible with `allow_multiple`.

Slack profile names are display metadata and are never used as authorization keys.

## Concurrency and Idempotency

The Session orchestrator is the source of truth for question status. It serializes answer attempts and accepts only an answer whose question is still open. The first valid answer wins; later attempts cannot overwrite it.

Slack retries converge on the already-accepted state rather than producing a second answer. The Session Durable Object serializes answer attempts, and the conditional `status = 'open'` transition makes the accepted question state the idempotency boundary.

When an interaction is stale, Codevil updates the Slack message from current Session state and tells the clicking user that the question was already answered.

## Message Updates and Errors

After a successful answer, the question message becomes read-only and shows:

- the original question;
- the accepted option labels;
- `Answered by <@USER_ID>`;
- the **Open session** link.

The endpoint acknowledges Slack promptly and performs Session submission and message updates in background work where necessary.

Failure behavior:

- invalid signatures receive an unauthorized response and perform no reads or writes beyond verification;
- malformed or unsupported actions receive a safe error and perform no Session mutation;
- missing or mismatched conversation links are rejected;
- transient Session or Slack API errors leave controls available for retry and send an ephemeral failure message when possible;
- profile lookup failure falls back to the Slack user ID;
- a Slack message-update failure does not roll back an answer already accepted by the Session.

## Manifest and API Changes

The generated Slack manifest will enable interactivity with the request URL:

```text
<worker-origin>/slack/actions
```

The existing `chat:write` and `users:read` bot scopes cover message publishing/updating and display-name lookup. The endpoint uses the existing Slack signing secret and does not introduce another credential.

`SlackMessageInput` will support structured `blocks` in addition to fallback `text`. A separate update helper will call `chat.update` with the channel and original message timestamp.

## Compatibility and Limits

Slack message composition limits are enforced at the adapter boundary. The renderer will:

- keep Markdown content within Slack's cumulative Markdown-block limit;
- keep messages within the maximum block count;
- select controls based on Slack's per-element option limits;
- truncate only presentation labels, never option IDs;
- fall back to a safe message with **Open session** if a question cannot be represented interactively.

Long agent responses that exceed one Markdown payload will be split at safe textual boundaries into ordered Slack messages rather than silently clipped. Code fences must remain balanced across chunks.

## Testing

### Rendering tests

- standard headings, emphasis, links, lists, inline code, fenced code, and block quotes are preserved in a native Markdown block;
- the reported GitHub pull-request URL case produces standard Markdown without literal leaked `*` markers;
- Markdown tables remain intact for Slack's native table rendering;
- top-level fallback text is useful and contains no raw table syntax;
- long responses are split without clipping or broken code fences;
- each question shape produces the correct controls and safe fallback.

### Client tests

- `chat.postMessage` receives `text`, `blocks`, and `thread_ts` correctly;
- `chat.update` receives the original channel and message timestamp;
- Slack API errors remain observable and do not throw unsafe payload data into logs;
- `users.info` display-name resolution follows the documented fallback order.

### Route and security tests

- valid signed `block_actions` payloads are accepted;
- bad, missing, and stale signatures are rejected;
- bot actors, wrong workspaces, channels, threads, Sessions, questions, and option IDs are rejected;
- single- and multiple-choice selections are validated;
- a valid Slack actor is mapped to the expected external participant identity.

### Session tests

- an open question accepts a Slack-originated answer and resumes the sandbox;
- simultaneous answers accept exactly one result;
- a retry returns the accepted state without duplicating events;
- stale interactions cannot overwrite an answer;
- message-update and profile-lookup failures do not undo an accepted answer.

## Documentation

The README Slack section will describe native formatting, option-based answers, the interactivity request URL, and the first-answer-wins behavior. It will continue to state that free-form Slack modals, account linking, and Slack-native plan approvals are deferred.
