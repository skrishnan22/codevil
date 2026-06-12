# Collaborative Plan Annotation (v1 — Co-present Annotation → Consolidated Refinement)

> **Date:** 2026-06-12
> **Status:** Design approved, ready for implementation plan
> **Revised:** 2026-06-12 — incorporated design-review resolutions (plan-gate entry,
> revision keying, session-creator decider, locked review windows, disposable
> consolidation context, state machine, thread lifecycle, consolidation bounds,
> annotation UI stack). See [Review resolutions](#review-resolutions-2026-06-12).
> **Scope:** Shared contracts (`@codevil/shared`) + Orchestrator DO + web UI. No new infra (no D1, no R2 in v1).

## Review resolutions (2026-06-12)

A design review surfaced two foundational gaps and a set of under-specified mechanics.
The resolutions are folded into the sections below; this is the summary.

1. **The plan/approval gate is dormant, not missing.** Nothing in the current web flow
   enters `planning`/`awaiting_approval` — `agent_request` goes straight to execution, and
   CONTEXT.md states plan approval is *not* the default loop. But the **sandbox plan+refine
   path is fully built**: `runtime.ts` handles a `plan` turn and emits `plan_ready`, the
   `plan` message exists in the schema, and `handleRefine` already sends `refine_plan`. The
   only missing wire is the orchestrator sending the initial `plan` message. **Resolution:**
   a run opts into the gate via a `plan_first` flag on the Agent Request, and that flag is
   persisted on the Agent Run. The default stays no-gate (consistent with CONTEXT.md);
   annotation only exists on plan-first runs. Reviving the gate is "wire up a
   complete-but-untriggered path," not new subsystem.
2. **Revisions are keyed per run, not per session.** A Session holds many Agent Runs and
   `startAgentRun` resets `refinement_round = 0` for each. Keying a revision by `round`
   alone collides across runs. **Resolution:** key by `(run_id, round)`.
3. **Plan-first must survive queueing.** The `plan_first` flag is per Agent Run, not a
   transient socket message detail. **Resolution:** persist `plan_first` on `AgentRun` so
   queued runs still enter the gate when they eventually start.
4. **The DO does not know the Decider.** `created_by` lives only in D1; `SessionMeta` has
   no creator field, and names are spoofable. **Resolution:** pass the authenticated
   session creator into `init`, persist it, and authorize `conflict_resolve` against the
   authenticated `auth.userId` from the socket attachment. v1 deliberately uses the
   session creator for the whole Session. Null creator → any Owner-role member decides.
5. **Refine locks the revision.** Once refine starts, Revision N rejects new annotations,
   replies, and withdraws. Chat discussion may continue, but it is not included in the
   in-flight refinement pass.
6. **Thread lifecycle.** Status is `open | withdrawn | consumed`. Authors withdraw their
   own open threads; Consolidation marks surviving threads `consumed` when N+1 freezes.
   No manual "resolve" action in v1 (so no `annotation_resolve` message).
7. **Round accounting.** `refinement_round` increments only when a clean brief dispatches
   and the agent produces N+1. Conflict back-and-forth inside one refine does not burn
   budget. The `MAX_REFINEMENT_ROUNDS` guard is checked at refine-click; the increment
   happens at brief dispatch.
8. **Consolidation uses a disposable Pi context.** Consolidation runs as one prompt in a
   fresh, temporary in-memory Pi `AgentSession` inside the sandbox, then calls
   `dispose()`. It does not reuse the planning/refinement/execution agent transcript.
   Prefer read-only tools (`read`, `grep`, `find`, `ls`) for repo context; `tools: []` is
   an acceptable fallback if we decide repo reads are not worth the risk/cost.
9. **Consolidation is bounded.** The post-resolution pass runs **compose-only** (pinned
   resolutions are authoritative; it may not raise new conflicts), so resolution cannot
   livelock. A lone open thread (incl. the "refine with a note" case) skips the Pi turn.
10. **Consolidation fails closed but re-triggerable.** Sandbox death mid-consolidation or
   schema-invalid Pi output returns the run to `awaiting_approval` with an error — never a
   wedged round or a `failed` session.
11. **Annotation UI is libraries + thin glue, not a fork.** Only `@plannotator/web-highlighter`
   is published (npm, MIT, maintained); plannotator's `@plannotator/ui` (parser, highlighter
   hook, exporter) is unpublished internal code. **Resolution:** depend on
   `@plannotator/web-highlighter@0.8.1` for selection/anchor-serialization/paint/restore and
   on the existing `react-markdown` for rendering + source lines; write only thin first-party
   glue for the rest. The stored anchor is web-highlighter's own `HighlightSource`
   serialization, not a hand-rolled source-offset record. See [Web surface](#web-surface).

## Goal

Let the Members already co-present in a Codevil **Session** annotate the agent's generated
plan **inline**, discuss in the room, and have their feedback turned into **one coherent
instruction set** before it reaches the coding/refinement agent (Pi). When Members choose
refinement and disagree, the disagreement is surfaced and settled by a human **before**
the refinement agent acts. The only bypass is explicit approval of the frozen plan as-is,
which discards annotation feedback instead of sending it to the agent.

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
- **The approval gate is dormant in the web flow.** `agent_request` → `startAgentRun` goes
  `ready → executing` directly; nothing transitions into `planning`/`awaiting_approval`, and
  CONTEXT.md records this as deliberate. The sandbox can already plan (`runtime.ts` handles a
  `plan` turn, emits `plan_ready`) and refine (`handleRefine` sends `refine_plan`) — only the
  orchestrator never initiates a `plan` turn. This design re-activates that path as an
  **opt-in** per-run gate, so the default loop is unchanged.

## Guiding principles

- **Reuse the existing event/broadcast/replay machinery.** Annotations are discrete,
  append-only events — not co-edited prose — so no CRDT. New message types flow through
  `appendAndBroadcast` like everything else.
- **Approve stays the fast path.** If the room is happy, one `approve` ships the plan
  as-is. Annotation only matters when someone wants changes.
- **The orchestrator owns the gate**, not the agent's good behavior. Pi *proposes*;
  the DO *decides* whether feedback is allowed through.

## In scope (v1)

- **Plan-first Agent Request**: a per-run `plan_first` flag, carried on `agent_request`
  and persisted on `AgentRun`, that routes the run through the (re-activated) plan gate
  — `ready → planning → awaiting_approval` — instead of straight to execution. Annotation
  only exists on plan-first runs; the default loop is untouched.
- Inline **text-range** annotations on the current plan, anchored to an immutable
  **Plan Revision**.
- **Threads**: replies + a status (`open → withdrawn | consumed`) — the room's discussion
  surface before anything reaches the agent.
- **Consolidation** on `refine`: a disposable Pi context reads the revision + all open
  threads and returns a structured `{ brief_items, conflicts }`.
- **Conflict MCQs** rendered in chat, visible to the whole room, discussed by anyone.
- **Single decider** (the session creator in v1) answers each conflict MCQ.
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
- **Unifying all approve/refine actions under the decider.** v1 keeps ordinary
  approve/refine from `awaiting_approval` open to any participant (today's behavior).
  Conflict resolution and approve-as-is from `awaiting_resolution` are Decider-only because
  they settle or discard a known disagreement. The asymmetry is deliberate: anyone can push
  an uncontested plan forward, only the creator settles a genuine disagreement.
- **HTML / non-markdown artifact annotation.** Markdown plans only. (When added, the HTML
  blob goes to R2, keyed from a SQLite row — see Storage.)
- **Block-level or whole-document annotation modes.** Inline text ranges only.
- Reactions/emoji beyond a basic reply thread, typing indicators, presence-on-annotation.

## Domain language (additions to CONTEXT.md)

- **Plan-first run** — an Agent Run started with `plan_first: true`, persisted on the run,
  which pauses at a Plan Revision for review/annotation instead of executing immediately.
  The default (no-gate) run is unchanged. _Avoid: "plan mode" in UI._
- **Plan Revision** — the immutable plan markdown for one refinement round, addressed by
  `(run_id, round)`. Replaces the moving `latest_plan` string with an addressable, frozen
  artifact. _Avoid: "draft", "plan version" in UI._
- **Annotation** — one Member's comment anchored to a **text range** within a Plan
  Revision, stored as a text-quote anchor.
- **Annotation Thread** — an Annotation plus its replies, with status
  `open → withdrawn | consumed`. An author **withdraws** their own open thread; Consolidation
  marks a surviving thread **consumed** when the next revision freezes. There is no manual
  "resolve" action in v1. Where the room discusses before feedback reaches the agent.
- **Consolidation** — the agent-assisted merge. A one-prompt, disposable Pi context that
  reads the revision + open threads and returns structured `{ brief_items, conflicts }`.
  It runs inside the sandbox but is not the planning/refinement/execution Pi session.
  _Avoid: "merge" in UI._
- **Refinement Brief** — the clean, deduped, non-contradictory instruction set Pi receives.
  The planning/refinement/execution agent receives this — never raw annotations or conflicts.
- **Conflict** — two or more threads Consolidation judged to semantically contradict.
  Rendered as an MCQ in chat; settled by the decider. _Avoid: "clash"._
- **Decider** — the single Member who answers conflict MCQs. In v1 this is the session
  creator for the Session's lifetime; transfer/handoff is deferred.

## The guarantee (stated honestly)

The coding/refinement agent never **acts on** unresolved conflicting information. A
temporary Consolidation Pi context may *see* contradictions — that is how it detects them
— but that context is disposed after one prompt and is never reused for plan refinement or
execution. The orchestrator blocks any brief/`refine_plan` while a non-empty unanswered
`conflicts` set exists. If the room approves the frozen plan as-is while conflicts exist,
those threads/conflicts are explicitly discarded rather than sent to the agent.

## Lifecycle & state flow

```
0. PLAN-FIRST ENTRY (opt-in)
   - Agent Request carries plan_first: true
   - orchestrator stores plan_first on the Agent Run before it may be queued
   - orchestrator sends a `plan` turn to the sandbox: ready → planning
   - (a default run without the flag goes ready → executing as today; no gate)

1. Agent emits plan (plan_ready)
   → orchestrator freezes it as Plan Revision (run_id, round N): planning → awaiting_approval
   → markdown moves into plan_revisions; latest_plan string retired for plan-first runs

2. REVIEW WINDOW  (state: awaiting_approval)
   - Members select text ranges in Revision N → open threads (anchored)
   - Replies, author-withdraw — all live-broadcast to the room
   - approve is available at any point and BYPASSES annotation entirely

3. Someone clicks REFINE  (awaiting_approval → refining)
   - guard: reject if refinement_round already == MAX_REFINEMENT_ROUNDS
   - Revision N is locked immediately: no new annotations, replies, or withdraws
   - orchestrator gathers all OPEN threads on Revision N
   - 0 or 1 open thread → SKIP the Pi turn, build the brief directly (deterministic)
   - else run CONSOLIDATION (one disposable Pi prompt) → { brief_items, conflicts }
       ├─ conflicts == []  → build Refinement Brief from brief_items
       │                     → send refine_plan to sandbox; refinement_round++ AT DISPATCH
       │                     → agent produces Revision N+1 (plan_ready → awaiting_approval)
       │                     → threads on N marked consumed; fresh slate on N+1
       │
       └─ conflicts != []  → refining → awaiting_resolution; brief BLOCKED; round NOT
                             incremented; each conflict broadcast as an MCQ card in chat

4. CONFLICT RESOLUTION  (state: awaiting_resolution — only if step 3 found conflicts)
   - MCQ visible to whole room; anyone discusses in chat
   - ONLY the Decider answers each MCQ: pick an option OR write a deciding instruction
   - no race (single writer of the answer), attributed
   - ESCAPE HATCH: Decider may approve here → ships the frozen Revision N as-is,
     explicitly discarding the open threads/conflicts (awaiting_resolution → executing)
   - when all conflicts answered → awaiting_resolution → refining; Consolidation re-runs
     COMPOSE-ONLY (resolutions pinned, may NOT raise new conflicts) → clean brief
     → refine_plan → refinement_round++ → Revision N+1
```

### State machine changes (shared/src/session.ts)

- New state **`awaiting_resolution`** (humans settling conflicts; no sandbox work in flight).
- New transitions: `refining → awaiting_resolution`, `awaiting_resolution → refining`
  (re-run after all conflicts answered), `awaiting_resolution → executing` (approve-as-is),
  plus `failed | timed_out | cost_exceeded` from `awaiting_resolution`.
- `awaiting_resolution` joins `awaiting_approval` in the `webSocketClose` tolerance check
  (orchestrator.ts:335) so a sandbox disconnect during a (possibly long) human resolution
  does not fail the session.

### Changes to existing decision handlers

- **Plan-first entry:** `handleAgentRequest`/`startAgentRun` branch on `plan_first`. When
  set, the orchestrator sends a `plan` turn (`ready → planning`) instead of `agent_turn`
  (`ready → executing`). The `plan` message and `plan_ready` handling already exist; only
  this branch is new. `plan_first` is stored on `AgentRun` so queued plan-first requests
  still enter the gate later.
- `handleRefine(feedback, actor)` → consolidation-driven refine. It gathers open threads,
  runs Consolidation (or the deterministic skip for ≤1 thread), and only sends `refine_plan`
  to the sandbox once a clean brief exists. A lone free-text note (no annotations) is the
  single-thread skip path, preserving the quick "refine with a note" flow.
- `annotation_create`, `annotation_reply`, and `annotation_withdraw` are only valid for the
  current Plan Revision while the run is in `awaiting_approval`. Once refine is clicked,
  Revision N is locked and the DO rejects further annotation mutations for that revision.
  Room chat remains available during `refining` and `awaiting_resolution`, but chat messages
  are not part of the locked refinement input.
- **Round accounting:** the `MAX_REFINEMENT_ROUNDS` check stays at refine-click, but the
  `refinement_round++` moves to **brief dispatch** (when `refine_plan` is sent). A refine
  that stalls in `awaiting_resolution` does not consume a round.
- `approve` — bypasses all annotation/consolidation from `awaiting_approval`. From
  `awaiting_resolution`, approve is a Decider-only escape hatch because it discards known
  conflicts. In both cases it ships the current frozen Plan Revision; pending
  threads/conflicts are discarded, not sent to Pi.
- A non-empty unanswered `conflicts` set holds the run in `awaiting_resolution` and blocks
  any brief/`refine_plan` until the Decider settles every conflict (the hard gate).
- **Failure path:** if Consolidation's Pi turn errors or returns schema-invalid output, the
  run returns to `awaiting_approval` with an `error` event — the round is not consumed and
  refine can be retried. Revision N remains locked; retry or approve-as-is are allowed, but
  no new annotation mutations are accepted for that revision.

## Consolidation (the crux)

- **Where it runs:** a fresh, temporary Pi `AgentSession` inside the sandbox, coordinated by
  the orchestrator — *not* a separate worker-side model call, and not the long-lived
  planning/refinement/execution session. The sandbox creates the context, sends one prompt,
  validates/parses the structured result, and calls `dispose()` in a `finally` block.
- **Tool policy:** prefer read-only tools (`read`, `grep`, `find`, `ls`) so Consolidation can
  use repo context to pre-dissolve false conflicts (e.g. "use JWT" vs "use sessions" when
  the repo already has session infra). If read-only repo access proves noisy or risky, v1 may
  run the temporary session with `tools: []`; either way it must never expose `bash`, `edit`,
  `write`, or `create_pull_request`.
- **Context isolation:** raw annotations and conflicts enter only this disposable
  Consolidation context. The active planning/refinement/execution Pi session is not prompted
  with raw threads. It receives only the final Refinement Brief after the DO has accepted it.
- **Input:** the frozen Revision markdown + every open thread
  `{ id, anchoredQuote, sourceLine, authorName, comment, replies[] }` + any prior
  resolutions. `anchoredQuote` is the web-highlighter `text` (the selected span) and
  `sourceLine` is the derived 1-based line — both let Pi locate the comment inside the
  markdown it is reading, without any offset bookkeeping crossing the wire.
- **Output contract (structured event, not free text):**

```jsonc
{
  "brief_items": [
    { "instruction": "...", "source_thread_ids": ["t1", "t4"] }  // provenance
  ],
  "conflicts": [
    { "thread_ids": ["t2", "t3"],
      "summary": "Auth approach: t2 wants sessions, t3 wants JWT",
      "options": [ { "thread_id": "t2", "gist": "sessions" },
                   { "thread_id": "t3", "gist": "JWT" } ] }
  ]
}
```

- **Two-tier merge logic Pi is prompted to apply:**
  1. **Compatible / complementary** threads → merged or kept as distinct brief items. No
     human needed.
  2. **Contradictory** threads (same decision, opposing direction) → emitted as a Conflict,
     **never** silently merged.
- **Deterministic skip:** with 0 or 1 open thread there is nothing to reconcile (a conflict
  needs ≥2 threads), so the orchestrator builds the brief directly and **skips the Pi turn
  entirely**. This covers the common "refine with a note" case at zero model cost.
- **Compose-only re-run:** the pass that runs *after* the Decider answers conflicts is given
  the pinned resolutions and instructed it **may not raise new conflicts** — it only composes
  the brief. This bounds resolution to a single human round-trip and prevents livelock.
- **Gate enforcement is the orchestrator's**, not Pi's: the DO treats any `conflicts`
  entry as a hard block. Pi proposing conflicts ≠ Pi deciding.
- **Fails closed:** if the Pi turn errors, the sandbox disconnects, or the output fails the
  `{ brief_items, conflicts }` schema, the orchestrator emits an `error`, leaves the round
  un-incremented, and returns the run to `awaiting_approval` so refine can be retried. It
  never produces a brief from a partial/invalid result.
- **Accepted costs:** detection is a full Pi turn (not sub-cent); behavior is
  non-deterministic, so detection is covered by **eval-style** tests (run out-of-CI, not on
  every push), not pure unit tests.

### Sandbox consolidation contract

Add explicit DO → sandbox and sandbox → DO messages. Do not tunnel Consolidation through
`refine_plan`; `refine_plan` is reserved for the clean brief that the planning/refinement
agent should see.

**DO → sandbox:**

```jsonc
{
  "type": "consolidate_annotations",
  "request_id": "con_...",
  "run_id": "run_...",
  "mode": "detect" | "compose_only",
  "model": "claude-...",
  "provider": "anthropic",
  "revision": {
    "run_id": "run_...",
    "round": 2,
    "markdown": "..."
  },
  "threads": [
    {
      "id": "ann_...",
      "anchoredQuote": "...",
      "sourceLine": 42,
      "authorName": "Alice",
      "comment": "...",
      "replies": [{ "authorName": "Bob", "body": "..." }]
    }
  ],
  "resolutions": [
    {
      "conflict_id": "conf_...",
      "selected_thread_id": "ann_...",
      "deciding_instruction": "..."
    }
  ]
}
```

**Sandbox → DO success:**

```jsonc
{
  "type": "consolidation_complete",
  "request_id": "con_...",
  "result": {
    "brief_items": [
      { "instruction": "...", "source_thread_ids": ["ann_..."] }
    ],
    "conflicts": [
      {
        "id": "conf_...",
        "thread_ids": ["ann_a", "ann_b"],
        "summary": "...",
        "options": [
          { "thread_id": "ann_a", "gist": "..." },
          { "thread_id": "ann_b", "gist": "..." }
        ]
      }
    ]
  },
  "cost": { "input_tokens": 0, "output_tokens": 0, "total_cost_usd": 0 }
}
```

**Sandbox → DO failure:**

```jsonc
{
  "type": "consolidation_failed",
  "request_id": "con_...",
  "message": "schema-invalid output"
}
```

The DO ignores stale `request_id`s and treats `consolidation_failed`, sandbox disconnect, or
schema-invalid output as the same fail-closed path: emit an `error`, return the run to
`awaiting_approval`, keep Revision N locked, leave `refinement_round` unchanged, and allow
retry or approve-as-is.

## Conflict resolution

- Conflicts render as **MCQ cards in chat** (`conflict_raised` event), visible to all.
- Discussion happens in chat — any Member can weigh in. (Pi does **not** participate in
  conflict discussion in v1; there is no machinery for a constrained side-turn while a run is
  gated. Deferred.)
- **Only the Decider answers** (`conflict_resolved` event, Decider-authored): pick an
  `option.thread_id` (choose a side) or supply `deciding_instruction` (override both).
- **Decider identity is authenticated, not self-declared.** The DO learns the creator by
  taking `created_by` into `Orchestrator.init`, persisting it in `SessionMeta`, and
  authorizing `conflict_resolve` against `auth.userId` from the socket attachment — never the
  spoofable `participant_id`/display name (see `multiplayer.ts`). The new client→DO message
  types are added to the exhaustive `authActionForClientMessage` switch. If `created_by` is
  absent (legacy session), the fallback is "any Member with the `owner` role may decide."
  This is intentionally session-scoped in v1: a later run dispatched by someone else still
  uses the original session creator as Decider. Known limitation: if that creator is AFK,
  conflict resolution stalls until the room either waits or uses an allowed approve-as-is
  escape hatch.
- Single writer of the answer ⇒ **no race**, so no race-guard needed on resolution.
- When all conflicts for the round are answered, Consolidation re-runs **compose-only** with
  resolutions pinned, and the winning side flows into the brief with full provenance.

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

plan_revisions     (new)     -- immutable frozen plan, one row per (run, refine round)
   run_id TEXT NOT NULL,             -- Agent Run; rounds reset to 0 per run
   round INTEGER NOT NULL,
   markdown TEXT NOT NULL,
   locked_at TEXT,                   -- set when refine starts; blocks annotation mutations
   frozen_at TEXT NOT NULL,
   PRIMARY KEY (run_id, round)       -- NOT round alone: many runs per DO collide on round 0

annotations        (new)     -- MUTABLE current-state projection (queryable threads)
   id TEXT PRIMARY KEY,
   revision_run_id TEXT NOT NULL,    -- FK half (run_id, revision_round) → plan_revisions
   revision_round INTEGER NOT NULL,
   anchor_json TEXT NOT NULL,        -- web-highlighter HighlightSource { startMeta, endMeta, text } + { blockId, sourceLine }
   author_id TEXT NOT NULL,          -- authenticated user id; used for withdraw authz
   author_name TEXT NOT NULL,
   comment TEXT NOT NULL,
   status TEXT NOT NULL,             -- open | withdrawn | consumed
   created_at TEXT NOT NULL

annotation_replies (new)
   id TEXT PRIMARY KEY,
   annotation_id TEXT NOT NULL,
   author_id TEXT NOT NULL,
   author_name TEXT NOT NULL,
   body TEXT NOT NULL,
   created_at TEXT NOT NULL

annotation_conflicts (new)
   id TEXT PRIMARY KEY,
   revision_run_id TEXT NOT NULL,
   revision_round INTEGER NOT NULL,
   summary TEXT NOT NULL,
   options_json TEXT NOT NULL,        -- [{ thread_id, gist }]
   status TEXT NOT NULL,              -- open | resolved | discarded
   created_at TEXT NOT NULL

conflict_resolutions (new)
   conflict_id TEXT PRIMARY KEY,
   decider_id TEXT NOT NULL,
   decider_name TEXT NOT NULL,
   selected_thread_id TEXT,
   deciding_instruction TEXT,
   created_at TEXT NOT NULL
```

Key split: `events` is the **immutable log** (replay); `annotations`/`annotation_replies`
are the **mutable projection** Consolidation queries ("all open threads on revision
`(run_id, N)`") and mutates (`open → consumed`). Same event-log + materialized-view pattern
already used by `events` + `session_meta`. `session_meta` tracks the **active run + current
round**, the session creator/Decider, and any active `consolidation_request_id`; for
plan-first runs the markdown moves out of `latest_plan` into `plan_revisions`. `AgentRun`
itself gains `plan_first: boolean` so the gate survives queueing.

**Forward-looking rule** (for the deferred HTML-artifact feature): text → DO-SQLite; large
binary artifacts (rendered HTML, images, attachments) → R2, with the object key referenced
from a SQLite row.

## Transport & sync

New message types in the `CLIToDOMessage` / `DOToCLIEvent` unions, all flowing through
`appendAndBroadcast` (live fan-out + replay for late-joiners):

- Client → DO: `agent_request` gains optional `plan_first: boolean`; `annotation_create`,
  `annotation_reply`, `annotation_withdraw` (author-only), `refine_plan` / `refine_run`
  (now trigger Consolidation for plan-first runs), and `conflict_resolve` (Decider only).
  **No `annotation_resolve`** — there is no manual resolve in v1; Consolidation does the
  consuming.
- DO → clients: `annotation_created`, `annotation_replied`, `annotation_withdrawn`,
  `consolidation_started`, `conflict_raised`, `conflict_resolved`, `brief_dispatched`,
  `plan_revision_frozen`, and an `annotations_consumed` signal when N+1 freezes (so clients
  clear the consumed slate).

Authorization: `authActionForClientMessage` (the exhaustive switch in `ws-authorization.ts`)
must map every new client message. Annotation create/reply/withdraw and refine messages map
to `sessions:control`; `conflict_resolve` additionally requires the actor to be the Decider,
checked in the DO against `auth.userId`. Approve from `awaiting_resolution` also requires
the Decider because it discards known conflicts; ordinary approve from `awaiting_approval`
keeps today's open multiplayer behavior.

### Client protocol payloads

These shapes are the source of truth for the new `@codevil/shared` Zod schemas. All
client-supplied strings are trimmed server-side; empty or oversized text is rejected using
the same 20 KB ceiling as room chat unless a tighter limit is noted.

**Client → DO**

```jsonc
// Start a normal or plan-first agent run.
{
  "type": "agent_request",
  "text": "Add rate limiting",
  "plan_first": true // optional; default false
}

// Create an anchored thread on the active Plan Revision.
{
  "type": "annotation_create",
  "run_id": "run_...",
  "round": 0,
  "anchor": {
    // web-highlighter HighlightSource (DOM-range serialization) + derived fields.
    "startMeta": { "parentTagName": "P", "parentIndex": 4, "textOffset": 0 },
    "endMeta": { "parentTagName": "P", "parentIndex": 4, "textOffset": 24 },
    "text": "Add Redis-backed locking",
    "blockId": "block-7",
    "sourceLine": 42
  },
  "comment": "Use the existing D1-backed storage instead."
}

// Reply to an open thread.
{
  "type": "annotation_reply",
  "annotation_id": "ann_...",
  "body": "Agree, Redis is not in this stack."
}

// Withdraw an author's own open thread.
{
  "type": "annotation_withdraw",
  "annotation_id": "ann_..."
}

// Resolve a conflict card. Exactly one of selected_thread_id or deciding_instruction
// must be present.
{
  "type": "conflict_resolve",
  "conflict_id": "conf_...",
  "selected_thread_id": "ann_..."
}

{
  "type": "conflict_resolve",
  "conflict_id": "conf_...",
  "deciding_instruction": "Use D1-backed storage; do not introduce Redis."
}
```

**DO → clients**

```jsonc
{
  "type": "plan_revision_frozen",
  "run_id": "run_...",
  "round": 0,
  "markdown": "## Plan...",
  "locked": false,
  "created_at": "2026-06-12T..."
}

{
  "type": "annotation_created",
  "annotation": {
    "id": "ann_...",
    "run_id": "run_...",
    "round": 0,
    "anchor": { "startMeta": { "...": "..." }, "endMeta": { "...": "..." }, "text": "...", "blockId": "block-7", "sourceLine": 42 },
    "author": { "id": "usr_...", "name": "Alice" },
    "comment": "...",
    "status": "open",
    "created_at": "2026-06-12T..."
  }
}

{
  "type": "annotation_replied",
  "reply": {
    "id": "rep_...",
    "annotation_id": "ann_...",
    "author": { "id": "usr_...", "name": "Bob" },
    "body": "...",
    "created_at": "2026-06-12T..."
  }
}

{
  "type": "annotation_withdrawn",
  "annotation_id": "ann_...",
  "actor": { "id": "usr_...", "name": "Alice" },
  "created_at": "2026-06-12T..."
}

{
  "type": "consolidation_started",
  "request_id": "con_...",
  "run_id": "run_...",
  "round": 0
}

{
  "type": "conflict_raised",
  "conflict": {
    "id": "conf_...",
    "run_id": "run_...",
    "round": 0,
    "summary": "Storage choice: Redis vs D1",
    "options": [
      { "thread_id": "ann_a", "gist": "Use Redis" },
      { "thread_id": "ann_b", "gist": "Use D1" }
    ],
    "status": "open"
  }
}

{
  "type": "conflict_resolved",
  "conflict_id": "conf_...",
  "actor": { "id": "usr_...", "name": "Creator" },
  "selected_thread_id": "ann_b",
  "deciding_instruction": null,
  "created_at": "2026-06-12T..."
}

{
  "type": "brief_dispatched",
  "run_id": "run_...",
  "from_round": 0,
  "to_round": 1,
  "brief_items": [
    { "instruction": "Use D1-backed storage.", "source_thread_ids": ["ann_b"] }
  ]
}

{
  "type": "annotations_consumed",
  "run_id": "run_...",
  "round": 0,
  "annotation_ids": ["ann_a", "ann_b"]
}
```

The DO is the single writer, so ordering and the Decider-only constraint are trivial to
enforce; no distributed conflict at the annotation layer.

## Web surface

- A right-rail review panel on the rendered Plan Revision, built from existing
  `components/activity` + `components/session`.
- The existing room composer remains the entry point: users still tag `@codevil` to direct
  the agent. Add a one-shot **Plan first** toggle beside the mention/send controls. The
  toggle is disabled unless the outgoing message is an agent request, defaults off, and
  resets to off after send. When enabled, the web store sends
  `{ type: "agent_request", text, plan_first: true }`; otherwise it sends the current
  no-gate `agent_request`.
- Do **not** build a markdown renderer/editor from scratch. v1 renders plans with the
  existing commodity stack (`react-markdown` + `remark-gfm`). Component overrides stamp each
  rendered block with `data-block-id` and its 1-based source line, read from the hast
  `node.position` that react-markdown already exposes — no separate parser, and no fork of
  plannotator's hand-rolled `parseMarkdownToBlocks`.
- Text selection opens a thread composer; threads render as margin markers + a list.
- **Selection, anchor serialization, highlight painting, and restore are delegated to
  `@plannotator/web-highlighter`.** It captures the selection, serializes it to a
  DOM-relative `HighlightSource` (`{ startMeta, endMeta, text }`), paints the `<mark>`, and
  re-resolves it later via `fromStore`. We do **not** reimplement DOM-range serialization.
  The stored anchor is exactly that serialization plus two derived fields — the enclosing
  `blockId` and `sourceLine` — which give Pi a "(line N)" label with no offset bookkeeping.
- **Cross-client restore.** Because every Member renders the *same frozen markdown* through
  the same renderer, a remote annotation's `startMeta`/`endMeta` resolve in everyone's DOM
  via `fromStore`; a small first-party quote-search fallback (re-find `text` within the
  enclosing `blockId`) covers the rare miss. That fallback is the one bit of plannotator's
  unpublished `findTextInDOM` logic we re-implement ourselves — it is not available as a
  package — kept deliberately small.
- **Immutability neutralizes the React hazard.** web-highlighter injects `<mark>` into the
  DOM, which normally fights React's reconciler — but a Plan Revision is frozen, so
  react-markdown renders it once and never re-renders it with new content during the review
  window. Highlights are added/removed on a stable tree; remote annotations only call
  `fromStore`. (Once refine locks the revision, even annotation creation stops — see the
  locked-revision resolution.)
- **`$root` scoping is load-bearing for cross-client restore.** A web-highlighter
  `HighlightSource` (`startMeta.parentTagName` / `parentIndex` / `textOffset`) is computed
  relative to the highlighter's `$root`, so the glue must scope `$root` to the
  rendered-revision container and keep that container's DOM structure byte-identical across
  Members. That falls out of rendering the same frozen markdown through the same renderer,
  but it is the assumption `fromStore` rests on: any per-client DOM divergence inside `$root`
  (a conditional wrapper, a client-only decoration, hydration drift) breaks DOM-path restore
  and forces the quote-search fallback. Keep the annotated container free of client-conditional
  markup, and cover it with a cross-client fixture (see Testing).
- Conflict MCQs render as distinct cards in the chat stream; option chips are interactive
  only for the Decider, read-only (with discussion) for everyone else.
- v1 deliberately simple: select → comment → reply → refine / settle conflicts. No
  Google-Docs-grade interaction polish until the model is proven.

### Dependencies (libraries + thin glue, no forking or copying)

- **`@plannotator/web-highlighter@0.8.1`** — published on npm, MIT, repo
  `github.com/backnotprop/web-highlighter`. This is the *maintained fork* (last publish
  2026-01-17), ahead of the now-dormant upstream `web-highlighter@0.7.4` (2021); consuming it
  is using a library, not maintaining a fork. Handles selection capture, anchor
  serialization, paint, and restore.
- **`react-markdown` + `remark-gfm`** — already in `packages/web`; reused for rendering and
  for the `node.position` source lines behind `data-block-id` / `sourceLine`.
- **Not consumable:** plannotator's `@plannotator/ui` and `@plannotator/shared` are
  unpublished internal workspace packages (`v0.0.1`, npm 404), so `parseMarkdownToBlocks`,
  `useAnnotationHighlighter`, `findTextInDOM`, and `exportAnnotations` cannot be installed.
  Their *patterns* inform this design, but the only first-party code we write is thin glue:
  the React hook wiring web-highlighter events to our DO `annotation_*` events, the
  quote-search restore fallback, and the line-label formatter that builds Pi's consolidation
  input. None of it is copied from plannotator.

## Testing strategy

- **Consolidation (eval-style, out-of-CI):** fixture thread sets → assert brief_items/conflicts
  shape. The important cases are contradictions ("make it blue" vs "make it green"),
  false-conflict dissolution given repo context, and the compose-only re-run **not** raising
  new conflicts once resolutions are pinned. Not run on every push (a live model turn).
- **Sandbox consolidation unit tests:** `consolidate_annotations` creates a fresh temporary
  agent, uses only read-only tools (or no tools if configured), captures one structured
  response, emits `consolidation_complete`, and calls `dispose()` in success and failure
  paths. The active planning/refinement agent must not receive raw annotation text.
- **Anchoring:** a web-highlighter `HighlightSource` round-trips — serialize a selection,
  re-render the frozen revision, and confirm `fromStore` (or the quote-search fallback)
  re-resolves the same range and the derived `sourceLine` matches the source. Includes the
  cross-client case: serialize a selection against one rendered `$root`, then `fromStore`
  it against a *separately rendered* `$root` of the same frozen markdown and assert the
  identical range — the fixture that guards the "DOM structure identical across Members"
  assumption. A companion case asserts the quote-search fallback recovers when DOM-path
  restore is deliberately perturbed.
- **Shared contract schemas:** every Client → DO, DO → client, DO → sandbox, and sandbox →
  DO payload listed above parses through Zod; invalid `conflict_resolve` messages with both
  or neither resolution field are rejected.
- **Web UI:** the composer exposes a one-shot Plan first toggle only for `@codevil`
  requests, sends `plan_first: true` when enabled, omits it otherwise, and resets the toggle
  after send.
- **State / gate (extend `multiplayer.test.mjs` + orchestrator tests):**
  - a `plan_first` run enters `planning → awaiting_approval`; a default run still goes
    straight to `executing` (no regression to the default loop);
  - a queued `plan_first` run preserves the flag until it starts;
  - refine locks Revision N and rejects later `annotation_create`, `annotation_reply`, and
    `annotation_withdraw` for that revision;
  - refine with an unresolved conflict holds in `awaiting_resolution` and produces no brief;
  - non-Decider `conflict_resolve` is rejected; Decider check is against `auth.userId`, and
    the null-creator fallback (owner-role) works;
  - approve from `awaiting_resolution` is rejected for non-Deciders and accepted for the
    Decider, discarding open conflicts without sending them to Pi;
  - `refinement_round` increments only at brief dispatch, not on a refine that stalls on
    conflicts (round-budget accounting);
  - approve bypasses cleanly from `awaiting_approval`, shipping the frozen revision;
  - a non-author `annotation_withdraw` is rejected;
  - threads on revision `(run_id, N)` are marked `consumed` when N+1 is frozen;
  - revisions for two runs in one DO do not collide (the `(run_id, round)` key);
  - a sandbox disconnect during `awaiting_resolution` does not fail the session;
  - Consolidation Pi-turn failure / schema-invalid output returns the run to
    `awaiting_approval` without consuming a round.
- **Pure helpers** (anchor (de)serialization, brief flattening) as unit tests.
