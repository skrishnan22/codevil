# Collaborative Plan Annotation (v1 — Co-present Annotation → Consolidated Refinement)

> **Date:** 2026-06-12
> **Status:** Design approved, ready for implementation plan
> **Scope:** Shared contracts (`@codevil/shared`) + Orchestrator DO + web UI. No new infra (no D1, no R2 in v1).

## Goal

Let the Members already co-present in a Codevil **Session** annotate the agent's generated
plan **inline**, discuss in the room, and have their feedback turned into **one coherent
instruction set** before it reaches the coding agent (Pi). When Members disagree, the
disagreement is surfaced and settled by a human **before** the agent acts — the agent
never *acts on* unresolved conflicting information.

This is plannotator's core loop (annotate a plan → send feedback to the agent), but owned
natively inside our multiplayer Session, with two things plannotator does not do:

1. **Live, co-present annotation** on the same plan, instead of share-a-link / import.
2. **Conflict resolution we own** — contradictory feedback is consolidated and settled in
   the room, so the agent receives a single clean brief, not "make it blue" + "make it green."

## Background: what already exists

- Each Session is one **Orchestrator Durable Object**. It broadcasts every event to all
  connected `cli` sockets via `appendAndBroadcast`, and clients replay the append-only
  SQLite `events` log on reconnect (`?cursor=N`).
- The DO persists in **embedded SQLite** (`ctx.storage.sql`): `events` (append-only log)
  and `session_meta` (key/value, currently holds `latest_plan` as a string).
- **D1 (`env.DB`)** is the global relational DB for team/auth data (memberships, invites,
  owners). It is **not** per-session and is untouched by this design.
- Multiplayer identity + attribution exists: `participant_joined` / `participant_left`,
  self-declared display names, and the approve/refine **first-action-wins** race guard
  (`describeDecisionRejection`, `last_decision`).
- The plan decision today is binary: `approve` (execute) or `refine(feedback, actor)`
  where `feedback` is a single free-text string. `latest_plan` is a moving string.

## Guiding principles

- **Reuse the existing event/broadcast/replay machinery.** Annotations are discrete,
  append-only events — not co-edited prose — so no CRDT. New message types flow through
  `appendAndBroadcast` like everything else.
- **Approve stays the fast path.** If the room is happy, one `approve` ships the plan
  as-is. Annotation only matters when someone wants changes.
- **The orchestrator owns the gate**, not the agent's good behavior. Pi *proposes*;
  the DO *decides* whether feedback is allowed through.

## In scope (v1)

- Inline **text-range** annotations on the current plan, anchored to an immutable
  **Plan Revision**.
- **Threads**: replies + a status (`open → resolved | withdrawn`) — the room's discussion
  surface before anything reaches the agent.
- **Consolidation** on `refine`: Pi reads the revision + all open threads and returns a
  structured `{ briefItems, conflicts }`.
- **Conflict MCQs** rendered in chat, visible to the whole room, discussed by anyone.
- **Single decider** (session creator/dispatcher) answers each conflict MCQ.
- **Hard gate**: while any conflict is unanswered, the DO refuses to produce a brief or
  accept a refined plan.
- Provenance: every brief item traces back to the threads it came from.

## Explicitly out of scope (deferred)

- **Re-anchoring annotations across plan versions.** Annotations are scoped to one
  immutable Plan Revision; a refine round consumes them and the next revision starts with
  a fresh slate. No cross-version anchor migration.
- **Decider handoff / transfer.** v1: the session creator is the sole decider for the
  session's lifetime. Known limitation: if the creator is AFK, conflicts stall. Transfer
  is the obvious first extension.
- **Unifying approve/refine under the decider.** v1 keeps approve/refine open to any
  participant (today's behavior). Only conflict resolution is decider-only. The asymmetry
  is deliberate: anyone can push the plan forward, only the creator settles a genuine
  disagreement.
- **HTML / non-markdown artifact annotation.** Markdown plans only. (When added, the HTML
  blob goes to R2, keyed from a SQLite row — see Storage.)
- **Block-level or whole-document annotation modes.** Inline text ranges only.
- Reactions/emoji beyond a basic reply thread, typing indicators, presence-on-annotation.

## Domain language (additions to CONTEXT.md)

- **Plan Revision** — the immutable plan markdown for one refinement round. Replaces the
  moving `latest_plan` string with an addressable, frozen artifact. _Avoid: "draft",
  "plan version" in UI._
- **Annotation** — one Member's comment anchored to a **text range** within a Plan
  Revision, stored as a text-quote anchor.
- **Annotation Thread** — an Annotation plus its replies, with status
  `open → resolved | withdrawn`. Where the room discusses before feedback reaches the agent.
- **Consolidation** — the agent-assisted merge. A constrained Pi "consolidate-mode" turn
  that reads the revision + open threads and returns structured `{ briefItems, conflicts }`.
  _Avoid: "merge" in UI._
- **Refinement Brief** — the clean, deduped, non-contradictory instruction set Pi receives.
  The agent only ever sees this — never raw annotations or conflicts.
- **Conflict** — two or more threads Consolidation judged to semantically contradict.
  Rendered as an MCQ in chat; settled by the decider. _Avoid: "clash"._
- **Decider** — the single Member (session creator/dispatcher) who answers conflict MCQs.

## The guarantee (stated honestly)

The agent never **acts on** unresolved conflicting information. Pi may *see* contradictions
during Consolidation — that is how it detects them — but the orchestrator blocks any plan
output and any brief until the Decider has settled every conflict. A non-empty `conflicts`
array structurally prevents a brief from being produced.

## Lifecycle & state flow

```
1. Agent emits plan
   → orchestrator freezes it as Plan Revision N (replaces latest_plan string)

2. REVIEW WINDOW (existing pre-approve state)
   - Members select text ranges in Revision N → open threads (anchored)
   - Replies, withdraw — all live-broadcast to the room
   - approve is available at any point and BYPASSES annotation entirely

3. Someone clicks REFINE
   - orchestrator gathers all OPEN threads on Revision N
   - runs CONSOLIDATION (Pi consolidate-mode turn) → { briefItems, conflicts }
       ├─ conflicts == []  → build Refinement Brief from briefItems
       │                     → existing handleRefine path → agent produces Revision N+1
       │                     → threads on N marked consumed; fresh slate on N+1
       │
       └─ conflicts != []  → session enters "needs resolution"; brief BLOCKED;
                             each conflict broadcast as an MCQ card in chat

4. CONFLICT RESOLUTION (only if step 3 found conflicts)
   - MCQ visible to whole room; anyone discusses in chat (humans + Pi)
   - ONLY the Decider answers each MCQ: pick an option OR write a deciding instruction
   - no race (single writer of the answer), attributed
   - when all conflicts answered → Consolidation re-runs with resolutions pinned in
     → clean brief → handleRefine → Revision N+1
```

### Changes to existing decision handlers

- `handleRefine(feedback, actor)` → `handleRefine(brief, actor)` where `brief` is
  Consolidation output. A lone free-text note (no annotations) is treated as a single
  trivially-mergeable thread, preserving the quick "refine with a note" path.
- `approve` unchanged — bypasses all annotation/consolidation.
- A non-empty unanswered `conflicts` set blocks `refine` from completing (new guard,
  alongside the existing state/round guards).

## Consolidation (the crux)

- **Where it runs:** a constrained Pi turn in the sandbox, coordinated by the orchestrator
  — *not* a separate worker-side model call. Pi has full repo context, so it pre-dissolves
  false conflicts (e.g. "use JWT" vs "use sessions" when the repo already has session infra).
- **Input:** the frozen Revision markdown + every open thread
  `{ id, anchoredQuote, authorName, comment, replies[] }` + any prior resolutions.
- **Output contract (structured event, not free text):**

```jsonc
{
  "briefItems": [
    { "instruction": "...", "sourceThreadIds": ["t1", "t4"] }  // provenance
  ],
  "conflicts": [
    { "threadIds": ["t2", "t3"],
      "summary": "Auth approach: t2 wants sessions, t3 wants JWT",
      "options": [ { "threadId": "t2", "gist": "sessions" },
                   { "threadId": "t3", "gist": "JWT" } ] }
  ]
}
```

- **Two-tier merge logic Pi is prompted to apply:**
  1. **Compatible / complementary** threads → merged or kept as distinct brief items. No
     human needed.
  2. **Contradictory** threads (same decision, opposing direction) → emitted as a Conflict,
     **never** silently merged.
- **Gate enforcement is the orchestrator's**, not Pi's: the DO treats any `conflicts`
  entry as a hard block. Pi proposing conflicts ≠ Pi deciding.
- **Accepted costs:** detection is a full Pi turn (not sub-cent); behavior is
  non-deterministic, so detection is covered by **eval-style** tests, not pure unit tests.

## Conflict resolution

- Conflicts render as **MCQ cards in chat** (`conflict_raised` event), visible to all.
- Discussion happens in chat — humans and Pi can weigh in.
- **Only the Decider answers** (`conflict_resolved` event, Decider-authored): pick an
  `option.threadId` (choose a side) or supply `decidingInstruction` (override both).
- Single writer of the answer ⇒ **no race**, so no race-guard needed on resolution.
- When all conflicts for the round are answered, Consolidation re-runs with resolutions
  pinned, and the winning side flows into the brief with full provenance.

## Storage

All session-scoped data lives in the **DO's embedded SQLite**. **D1 is untouched** (it is
for team/auth only). **R2 is not used in v1.** Rationale: plan markdown is KB-scale text,
far below any single-value limit; SQLite TEXT gives transactional co-location of a revision
with its annotations in one single-writer read. R2 is for large binary artifacts (MB+) and
would add a hop, eventual consistency, and break that atomic read.

A DO has **no general filesystem** — only KV + SQLite. "Write the plan as a file in the DO"
is not a thing; it is a SQLite row. (The sandbox container's filesystem is separate and
ephemeral, not the durable source of truth.)

Tables in DO-SQLite:

```
events             (exists)  -- append-only broadcast/replay log; annotation,
                                conflict, and resolution events land here too

plan_revisions     (new)     -- immutable frozen plan, one row per refine round
   round INTEGER PRIMARY KEY,
   markdown TEXT NOT NULL,
   frozen_at TEXT NOT NULL

annotations        (new)     -- MUTABLE current-state projection (queryable threads)
   id TEXT PRIMARY KEY,
   revision_round INTEGER NOT NULL,
   anchor_json TEXT NOT NULL,        -- { quote, prefix, suffix, startOffset, endOffset }
   author_id TEXT NOT NULL,
   author_name TEXT NOT NULL,
   comment TEXT NOT NULL,
   status TEXT NOT NULL,             -- open | resolved | withdrawn
   created_at TEXT NOT NULL

annotation_replies (new)
   id TEXT PRIMARY KEY,
   annotation_id TEXT NOT NULL,
   author_id TEXT NOT NULL,
   author_name TEXT NOT NULL,
   body TEXT NOT NULL,
   created_at TEXT NOT NULL
```

Key split: `events` is the **immutable log** (replay); `annotations`/`annotation_replies`
are the **mutable projection** Consolidation queries ("all open threads on revision N") and
mutates (`open → resolved`). Same event-log + materialized-view pattern already used by
`events` + `session_meta`. `session_meta` tracks only the **current round**; the markdown
moves out of `latest_plan` into `plan_revisions`.

**Forward-looking rule** (for the deferred HTML-artifact feature): text → DO-SQLite; large
binary artifacts (rendered HTML, images, attachments) → R2, with the object key referenced
from a SQLite row.

## Transport & sync

New message types in the `CLIToDOMessage` / `DOToCLIEvent` unions, all flowing through
`appendAndBroadcast` (live fan-out + replay for late-joiners):

- Client → DO: `annotation_create`, `annotation_reply`, `annotation_withdraw`,
  `refine` (now triggers Consolidation), `conflict_resolve` (Decider only).
- DO → clients: `annotation_created`, `annotation_replied`, `annotation_withdrawn`,
  `consolidation_started`, `conflict_raised`, `conflict_resolved`, `brief_dispatched`,
  `plan_revision_frozen`.

The DO is the single writer, so ordering and the Decider-only constraint are trivial to
enforce; no distributed conflict at the annotation layer.

## Web surface

- A right-rail review panel on the rendered Plan Revision, built from existing
  `components/activity` + `components/session`.
- Text selection opens a thread composer; threads render as margin markers + a list.
- Conflict MCQs render as distinct cards in the chat stream; option chips are interactive
  only for the Decider, read-only (with discussion) for everyone else.
- v1 deliberately simple: select → comment → reply → resolve. No Google-Docs-grade
  interaction polish until the model is proven.

## Testing strategy

- **Consolidation (eval-style):** fixture thread sets → assert briefItems/conflicts shape.
  The important cases are contradictions ("make it blue" vs "make it green") and
  false-conflict dissolution given repo context.
- **Anchoring (property-style):** text-quote anchors resolve back to the correct range in
  frozen markdown.
- **State / gate (extend `multiplayer.test.mjs` + orchestrator tests):**
  - refine with an open conflict is rejected;
  - non-Decider attempting `conflict_resolve` is rejected;
  - approve-during-annotation bypasses cleanly;
  - threads on revision N are marked consumed when N+1 is frozen.
- **Pure helpers** (anchor (de)serialization, brief flattening) as unit tests.
