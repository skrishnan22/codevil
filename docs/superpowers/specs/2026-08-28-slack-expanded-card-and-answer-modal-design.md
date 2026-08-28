# Slack Expanded Run Card and Answer Modal Design

## Goal

Make the Slack live run card readable without an extra click, show run activity in chronological order with restrained and explicit status indicators, and provide a first-class Slack modal for free-text question answers.

## Scope

This change extends the Slack UX work on `codex/slack-live-preview-ux` and PR #52.

It must:

- Replace the native `task_card` block with a Slack `container` block.
- Make the container collapsible but expanded on first render.
- Render visible activity from oldest to newest so the current activity is the final activity line.
- Use emoji-free typographic indicators with explicit status words for completed, active, and failed activity.
- Keep bounded activity history and duplicate-step collapsing.
- Keep option-only questions inline.
- Add a Slack modal for questions that allow free-form answers.
- Update the original Slack question message after a modal answer is accepted.

It must not:

- Treat a new threaded `@Codevil` message as an implicit question answer.
- Remove free-form capability from the shared question protocol or web UI.
- Add a D1 migration or a persistent Slack-question-message mapping.
- Change run execution, queueing, retry, teardown, or deployment behavior.

## Run Card

### Container behavior

`renderSlackRunCard` will emit one `container` block with:

- `is_collapsible: true`
- `default_collapsed: false`
- A revision-specific `block_id`
- The clean public request title without a decorative emoji
- A short status subtitle
- Child blocks for activity and links

The subtitle states the card-level condition in plain language: the current phase, waiting state, queue position, or terminal summary. The container's optional header `icon` is not used as a status marker because Slack exposes it only at the container level, not per activity row.

### Activity order

Visible activity is chronological. If history was omitted, the first detail line is `… N earlier steps`. Visible steps follow from oldest to newest. The current activity is therefore the final activity line and its explicit status label is bold.

Each activity row is structured rich text with a restrained typographic glyph, a bold status word, and the activity label:

- `✓ Completed — Reading files — page.tsx`
- `● Running — Editing code — Hero.tsx`
- `× Failed — Running tests`

The glyphs are plain text, not emoji. The status words make state understandable without relying on glyph shape or color. A completed row is never labelled `Running`, and only the current active row is labelled `Running`.

Consecutive identical steps remain collapsed. The card continues to show at most `MAX_VISIBLE_STEPS` activity rows, and the hidden count includes dropped, collapsed, and windowed rows.

### Links and terminal output

The container includes an `Open Codevil` link and a validated pull-request link when available. Terminal summaries appear once, not duplicated in both status and details.

## Free-Text Answer Modal

### Question rendering

Option-only questions continue to use the existing buttons, checkboxes, or select controls.

When `allowFreeform` is true, the question message adds a primary `Write answer` button. This applies whether or not predefined options are also present. `Open session` remains available as a secondary control.

The button value carries only a versioned request identifier. The Slack action payload supplies the trusted workspace, user, channel, thread, message timestamp, and short-lived `trigger_id`.

### Opening the modal

The Slack actions endpoint recognizes the `codevil_question_open_freeform` block action and calls `views.open` with its `trigger_id`.

The modal contains:

- Title: `Answer Codevil`
- The question and bounded context
- One required multiline `plain_text_input`
- Submit label: `Send answer`
- Cancel label: `Cancel`

The modal's server-generated `private_metadata` stores a versioned JSON object containing the request ID, team ID, channel ID, thread timestamp, and original question-message timestamp. The payload stays below Slack's metadata limit and is parsed with Zod on submission.

### Submitting the modal

The same Slack actions endpoint recognizes `view_submission` for the Codevil answer modal. It acknowledges the submission promptly and schedules processing through the existing `waitUntil` boundary.

Processing:

1. Resolves the existing Slack-thread-to-session link.
2. Rejects bot/app users and records the human actor using the existing integration identity boundary.
3. Calls the orchestrator's integration question-answer method with `requestId`, trimmed `freeform`, and the actor.
4. On success, updates the exact original question message using the message timestamp from server-generated metadata and `renderAnsweredSlackQuestion`.
5. On failure, posts the existing ephemeral failure style to the submitting user. An accepted answer is never rolled back because a later Slack message update failed.

The orchestrator integration method will accept either option indexes or free-form text while preserving all existing question validation: the question must be open, the sandbox must be connected, and the question must allow free-form input.

### Explicit V1 routing boundary

A normal threaded `@Codevil ...` app mention remains a new Agent Run request. It is not inspected or reinterpreted as an answer. Free-form question answers in Slack are submitted only through `Write answer` and the modal.

## Error Handling

- Invalid or stale modal metadata returns an unsupported/invalid interaction response without calling the orchestrator.
- A missing thread-session link produces an ephemeral error.
- A stale, already answered, non-free-form, or disconnected question uses the existing integration answer result and ephemeral feedback.
- `views.open` failures are logged and reported ephemerally to the user when possible.
- A successful answer followed by a failed `chat.update` remains successful; the failure is logged with session and message identifiers.

## Testing

Tests will prove:

- The live card is a `container` with `is_collapsible: true` and `default_collapsed: false`.
- Hidden history precedes chronological visible steps and the active step is last.
- Completed, active, and failed rows use the exact status words `Completed`, `Running`, and `Failed` with the restrained text glyphs `✓`, `●`, and `×`.
- The title contains no status emoji, and only the final visible activity row may be labelled `Running`.
- Free-form-capable questions include `Write answer`; option-only questions do not.
- A valid open action produces the expected `views.open` payload and versioned private metadata.
- A valid modal submission reaches the existing linked session with trimmed free-form text and updates the original question message.
- Invalid metadata, bots, missing links, stale questions, and Slack API failures do not create a new Agent Run request or consume the question incorrectly.
- Existing option-answer behavior remains green.
- The complete worker test suite and TypeScript type-check remain green.
