# Conflict Decision Card in the Conversation Pane

> **Date:** 2026-06-16
> **Status:** Design draft — for review before implementation
> **Scope:** `@codevil/web` only — UX/UI refinement of how plan-mode conflict questions surface to the user. No changes to the sandbox `ask_question` tool, the DO question broker, or the shared message contracts.
> **Builds on:** [2026-06-14 `ask_question` tool + prose consolidation](2026-06-14-ask-question-tool-and-prose-consolidation.md) (defines the tool that produces these questions) and [2026-06-12 collaborative plan annotation](2026-06-12-collaborative-plan-annotation-design.md) (defines the plan review panel).

## Goal

When Pi finds contradicting annotations during plan-review consolidation and calls `ask_question`, the human currently sees a small, low-contrast "Agent question" card in the conversation pane. It is **cramped/ugly** and lives in the **wrong place** — divorced from both the plan panel where the annotations live and from the conversational moment in which Pi is reasoning.

Redesign goals:
1. The conflict question reads like **a Pi message in the conversation stream**, not a settings form.
2. It carries the **weight of a decision moment** — large typography, visible quotes from both annotators with avatars, clear A-vs-B framing.
3. It surfaces at the **right time**: submitting comments closes the plan panel, Pi works, and the conflict (if any) lands as the next message in the conversation.
4. It does **not require** the user to reopen the plan panel to make the call — the relevant annotation quotes are inline. (An "Open in plan ↗" affordance is still there for context if wanted.)

## Out of scope

- Sandbox-side question contract, tool params, or broker delivery — already defined in the 2026-06-14 spec and unchanged.
- Non-conflict `ask_question` calls (e.g. future "which library should I use" questions). They continue to render via the generic `QuestionCard` path. This spec adds a richer specialization that the renderer picks when the question is conflict-shaped (see "Detecting a conflict question" below).
- Editing or withdrawing annotations from inside the conflict card — that already lives in the plan panel.

## User-visible flow

### 1. Submit comments → plan panel closes

In `PlanReviewPanel`, the existing "Send to agent" footer button already dispatches the comments. We add one effect: on successful dispatch, call `onClose()` to dismiss the panel automatically. The user's intent ("I'm handing this round to Pi") is implicit; the dismissal acknowledges it and returns focus to the conversation pane where Pi's response will appear.

### 2. Pi thinks (existing behavior)

The existing assistant-stream placeholder ("Pi · thinking…") shows in the conversation pane. No change.

### 3. Conflict surfaces as a Pi message

When the sandbox calls `ask_question` and the DO routes the `question.opened` event to the room, the conversation timeline renders the question **as a Pi-authored message**, with the Pi avatar in the left gutter and a `ConflictDecisionCard` as the message body. The card has:

- **Header chip:** `⚠ Decision needed`, a `§<section> · <topic>` reference (clickable — see "Open in plan ↗"), and, if more than one conflict is queued for this round, a `1 of N` pager.
- **Question text** (`question.question` field) at ~14.5px, weight 600.
- **Context paragraph** (`question.context`, if present) at 12.5px, secondary color.
- **Two side cards** in a grid (`1fr auto 1fr` with a centered "vs" cell), each side showing:
  - Annotator avatar + name + relative timestamp + annotation reference (`#14`)
  - Option label (from `question.options[].label`) at 13.5px bold
  - Italic quote of the annotation body (from `question.options[].detail`, which the consolidation agent populates with the annotation excerpt)
- **Action row:** "Open in plan ↗" link (reopens `PlanReviewPanel` scrolled to the section), "Add note…" ghost button (revealing the existing freeform textarea inline), "Commit: <chosen-name>'s call" primary button — disabled until a side is selected.

Visual treatment for weight: warning-tinted gradient background, 1px warning-tinted border, 16-18px padding, generous spacing between sides. Uses existing tokens (`--warn`, `--warn-soft`, `--accent`, `--surface`, `--r-lg`) so dark mode and accent themes inherit for free.

### 4. Selection + commit

Clicking a side selects it (border + soft-accent fill). Primary button label updates to `Commit: <name>'s call`. Clicking it dispatches the existing `answerQuestion` action with `{ optionIds: [selectedId], freeform: optionalNote }`. No new store actions or websocket messages.

### 5. Resolved state

Once answered, the card **collapses to a one-line summary** styled like a system note — same chip but green/`✓ Resolved`, plus "You picked <name>'s call — <label>". A "Show" link re-expands the full card (read-only) for audit. Subsequent Pi messages and any next queued conflict render below in the normal order.

### 6. Chat input gating

While at least one conflict-shaped question is `open`, the `ChatInput` is disabled with a hint: *"Resolve the decision above to continue."* Rationale: the conflict is structurally blocking — Pi is suspended in `ask_question` and cannot proceed regardless of what the user types — and locking input prevents the decision from scrolling out of sight under new chatter. Non-conflict `ask_question` calls do **not** disable input (they remain advisory).

## Detecting a conflict question

The generic `QuestionViewModel` from the 2026-06-14 spec carries `options[]` and `allowMultiple`. A question is rendered as a `ConflictDecisionCard` (instead of the existing `QuestionCard`) when **all** of:

- `options.length === 2`
- `allowMultiple === false`
- Each option's `id` matches an annotation thread id present in the current `planRevision.annotations` (the consolidation prompt sets `option.id = thread_id` — see 2026-06-14 spec, "stable option ids").

This keeps the routing logic local to the renderer; the question contract over the wire does not change. If any check fails (future generic questions, malformed payloads), we fall back to the existing `QuestionCard` — never lose the answer surface.

## Components

```
QuestionCard.tsx           (existing — kept for non-conflict questions)
ConflictDecisionCard.tsx   (new — rendered for conflict-shaped questions)
question-card.tsx          (becomes a router: picks Conflict vs generic)
```

`ConflictDecisionCard` is presentational. It reads from `useSessionStore`:
- `currentUserId`, `sessionCreatorId` — to compute `canAnswer` via the existing `canAnswerQuestion` predicate.
- `planRevision.annotations` — to resolve `option.id` (thread id) → `{ author, createdAt }` for the avatar/name/timestamp row.
- `answerQuestion` action — same one the existing card calls.

Auto-closing the plan panel on send happens in `PlanReviewPanel.handleSendToAgent` (one new line: `onClose()` after the existing dispatch).

Chat input gating reads `questions` from the store and toggles disabled state when any open question passes the conflict-shape check.

## States to design

| State | Trigger | Visual |
|---|---|---|
| `pending` | Pi has called `ask_question`, no selection yet | Full card, both sides unselected, Commit disabled |
| `selected` | User clicked a side | Side highlighted, Commit button enabled and labeled with the chosen name |
| `note-open` | User clicked "Add note…" | Inline textarea revealed below sides, above actions |
| `submitting` | Commit clicked, awaiting `question.answered` echo | Card disabled, spinner on Commit button |
| `resolved` | `question.answered` arrives, status = answered | Collapsed one-line `✓ Resolved` summary with "Show" toggle |
| `queued` | Another open conflict exists | Pager shows `N of M`; only the head-of-queue is expanded, others rendered as a "1 more decision queued" stub below |

## Error / edge handling

- **Annotation deleted between question.opened and selection** — render the side anyway using the option's `label` and `detail` from the question payload; show `· annotation withdrawn` next to the timestamp. Do not crash.
- **`canAnswer === false`** (you are not the decider) — sides are display-only, Commit is disabled, footer shows the existing waiting hint ("Waiting for the session creator to answer"). Chat input remains disabled because the decision still blocks Pi.
- **Plan panel was already closed when comments were sent** (e.g. user closed it manually first) — `handleSendToAgent` calling `onClose()` is a no-op; harmless.
- **More than two options** — falls through to the generic `QuestionCard`. The conflict card is strictly 2-up.

## Accessibility

- Card is a `<section role="region" aria-label="Decision needed: caching">`.
- Side cards are `<button aria-pressed>` (matches existing `question-option-button` semantics).
- Pager is `<span aria-label="Decision 1 of 2">`.
- Chat input's disabled state has an `aria-describedby` pointing to the visible hint.

## Out of scope (revisited)

- Withdrawing or editing annotations from inside the card.
- Side-by-side diff view of how each option would change the plan.
- A history pane of resolved conflicts (the collapsed inline summaries serve this — scrolling up shows them in order).

## Open questions

None — the questions raised during brainstorming (placement, weight, multi-conflict handling, chat-input gating, resolved-state treatment) all have answers above.
