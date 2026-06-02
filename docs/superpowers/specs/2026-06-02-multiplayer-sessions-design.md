# Multiplayer Sessions (v1 — Attributed Open Collaboration)

> **Date:** 2026-06-02
> **Status:** Design approved, ready for implementation plan
> **Scope:** Web client only. Backend (shared contracts + Orchestrator DO) + web UI.

## Goal

Let multiple teammates connect to one Codevil **Session** at the same time, all able to
approve / refine / abort the plan, with every action showing **who** did it. Simultaneous
decisions resolve **first-action-wins**.

## Background: what already exists

The observe side of multiplayer is already built and does not need changing:

- The Orchestrator Durable Object broadcasts every event to **all** connected `cli`
  sockets (`for (const ws of this.ctx.getWebSockets("cli"))` in `appendAndBroadcast`).
- Clients reconnect with `?cursor=N` and replay missed events from the append-only
  SQLite event log (`replayEvents`).

So "multiple people watching the same session live" works today. This design only layers
**identity + attribution** onto the **interact** side.

## Guiding principle

We are *only* layering a self-declared display name onto each connection and stamping it
onto the events that human actions already emit. **No new state machine, no new control
semantics, no new components.** The smallest change that makes multiplayer feel real.

## In scope (v1)

- Multiple teammates connect to one session simultaneously (already works).
- All connected members can approve / refine / abort.
- Every human action shows *who* did it (attribution chip in the stream).
- Simultaneous decisions resolve first-action-wins, naming the winner in the rejection.
- A web-client UI for the user to set their display name (in Settings).

## Explicitly out of scope (deferred)

- Real authentication / per-user tokens / SSO. Identity is a **cosmetic, self-declared
  display name**. Trust model is unchanged from today: whoever holds the shared
  `CODEVIL_API_KEY` is trusted. Attribution is best-effort and spoofable by design.
- Presence roster (who's currently connected).
- Teammate-to-teammate chat channel.
- Typing / "composing…" indicators.
- CLI support for setting a name. CLI actions will show as `Anonymous`.
- **Live reconnect on name change.** A name change applies on next session / reload, not
  mid-session (see §1 and §6). Live reconnect is deferred because it requires a connection-
  generation guard first (§6).

## Design

### 1. Identity on the wire (per-socket)

Identity rides the existing WebSocket upgrade connection — no new message type.

- The web client appends `?name=<display name>` to the upgrade URL, alongside the
  existing `?token=` and `?cursor=N`.
- On `acceptWebSocket`, the Orchestrator reads `name` from the query string, **sanitizes
  it** (see below), and stores it on the socket via `ws.serializeAttachment({ name })`, so
  it survives DO hibernation.
- Missing / blank / all-whitespace name → falls back to `"Anonymous"`.

**Name sanitization (server-side, in the DO).** The DO never trusts the raw `?name=`
value. Before storing/broadcasting it must:
- Trim leading/trailing whitespace and collapse internal runs of whitespace to a single
  space.
- Strip control characters and newlines (prevents log/UI injection and multi-line bloat).
- Cap length at **64 characters** (truncate; prevents SQLite row bloat since names are
  persisted in the event log).
- After sanitization, an empty result → `"Anonymous"`.

This is a data-hygiene measure, not a security boundary — names remain spoofable by anyone
holding the shared key, by design.

**When a name change takes effect (v1):** the name is captured at *connect time* and frozen
for the socket's lifetime. Saving a new name in Settings updates `localStorage` but does
**not** re-open the live socket — the session route only connects in a `useEffect` keyed on
session `id` (`session.$id.tsx`), which does not re-run on a config change. So a new name
applies on the **next session or a full page reload**, not mid-session. Live reconnect on
name change is explicitly deferred (see Out of scope and the note in §6).

### 2. Carrying the actor through the backend

- Add optional `actor?: string` to `StatusEventSchema` and `ErrorEventSchema` in
  `packages/shared/src/messages-cli.ts`. The lenient `PersistedDOToCLIEventSchema`
  already tolerates extra fields, so old persisted log rows remain valid.
- In `webSocketMessage`, read the acting socket's name via
  `ws.deserializeAttachment()?.name` and pass it into `handleApprove` /
  `handleAbort` / `handleRefine`.
- Those handlers stamp `actor` onto the `status` event they already emit:
  - **approve** → `"Plan approved. Starting execution."` + `actor`
  - **refine** → `"Refining plan (round n/N): …"` + `actor`
  - **abort** → `"Session aborted."` + `actor`

### 3. First-action-wins (simultaneous decisions)

First-action-wins governs the **plan decision at `awaiting_approval`** — i.e. the race
between `approve` and `refine`. Both only transition out of `awaiting_approval`, so the
single-threaded DO + state machine already guarantees exactly one winner; the loser's
message hits an invalid transition and is rejected.

**`abort` is deliberately NOT part of first-action-wins.** `handleAbort` succeeds in any
non-terminal state (`orchestrator.ts:381`), by design — it is an always-available kill
switch, not a plan decision. So "Alice approves, then Bob aborts while executing" is a
valid abort, not a lost race. The spec states this explicitly so the asymmetry with
`approve`/`refine` is intentional, not a bug.

We make a *rejected plan decision* name the winner:

- When a plan decision lands (`approve` or `refine` succeeds), store a structured
  `last_decision` in `session_meta`: `{ actor, action, refinement_round }`. Keying on
  `refinement_round` (the plan version) prevents misattributing a rejection to someone who
  acted on a *previous* plan.
- When a later `approve`/`refine` is rejected because the state already moved, the rejection
  `error`/`status` event carries `actor` + `action` from `last_decision` **only if its
  `refinement_round` matches the current round**; otherwise fall back to the generic
  `"Cannot approve in state: executing"`. Example friendly message:
  `"Alice already approved this plan."`
- `session_meta` is flat key/value `TEXT` storage, so `last_decision` is persisted as a
  JSON string under one key and parsed on read.

No locking, no claim protocol — the state machine is the arbiter.

### 4. Web client — identity entry (Settings)

- **Storage:** add an optional `displayName` field to the config in
  `packages/web/src/lib/config.ts` (same `localStorage`-backed `loadConfig` /
  `saveConfig`). Defaults to empty.
- **Entry point:** add a **"Display name"** `Input` to
  `packages/web/src/components/settings-dialog.tsx`. Optional field — it does **not**
  gate the Save button. Placeholder: `"Your name (shown to teammates)"`.
- **Wiring:** `buildWebSocketUrl` in `packages/web/src/lib/ws-client.ts` gains a
  `displayName?` param and appends `name=<encoded>` only when non-empty. The session
  store reads `config.displayName` and threads it through `connectWebSocket` →
  `buildWebSocketUrl`.
- **Behavior:** blank/unset name → no `name` param → DO falls back to `"Anonymous"`.

### 5. Web client — attribution rendering

- `packages/web/src/lib/event-mapper.ts` passes `actor` through to the mapped
  conversation / activity item.
- Timeline / Conversation components render a small attribution chip (`— Alice`) on
  status entries that carry an `actor`. Entries without `actor` render exactly as today
  (full backward compatibility).
- No new components — just an optional byline on existing status items.

### 6. Deferred: live reconnect & the connection-generation guard

v1 does **not** re-open the socket when the name changes (§1). This is intentional, because
naive live reconnect would surface a pre-existing race in `connectToSession`
(`session-store.ts:98`):

```
old.close()              // async — onclose fires later
new = connectWebSocket() // overwrites wsHandle
new.onopen  → status = "connected"     ✅
old.onclose → status = "disconnected"  ❌ stale callback clobbers live state
```

`WebSocket.close()` is asynchronous, so the old socket's `onclose` can land *after* the new
socket's `onopen` and wrongly flip `connectionStatus` to `disconnected`.

**Prerequisite for any future live reconnect:** add a monotonic connection-generation token;
`onOpen` / `onClose` callbacks mutate shared store state only when their captured `gen`
equals the current `connGen`. This is out of scope for v1 but documented so it isn't
rediscovered later. (It is latent today because `connectToSession` only re-runs on a session
`id` change, which fully remounts.)

## Testing

- **Shared / contract:** schema accepts `actor`; events round-trip through the lenient
  `PersistedDOToCLIEventSchema`.
- **Orchestrator (unit):**
  - two simulated `cli` sockets with different attached names; first `approve` wins and
    emits its `actor`; second `approve`/`refine` is rejected naming the winner; `refine`
    carries its actor; missing name → `Anonymous`.
  - `abort` succeeds while `executing` (kill-switch, *not* rejected as a lost race) and
    carries its actor.
  - rejection attribution only fires when `last_decision.refinement_round` matches the
    current round; a stale `last_decision` from a prior round falls back to the generic
    message.
  - **name sanitization:** whitespace trim/collapse, control-char/newline stripping,
    64-char cap, and empty-after-sanitize → `"Anonymous"`.
- **Event-mapper:** events with and without `actor` map correctly.
- **ws-client:** `buildWebSocketUrl` appends `name` when set, omits it when empty
  (existing `session-store.test.ts` URL assertion updated accordingly — URL unchanged
  when name empty).
- **Web UI:** attribution chip renders when `actor` is present, absent otherwise;
  Settings persists and reloads `displayName`.

## Files touched (anticipated)

- `packages/shared/src/messages-cli.ts` — `actor?` on status/error schemas.
- `packages/worker/src/orchestrator.ts` — read + sanitize name on accept, store
  attachment, stamp actor in handlers, structured `last_decision` (`{actor, action,
  refinement_round}`) in `session_meta`, round-matched rejection attribution.
- `packages/web/src/lib/config.ts` — `displayName` field.
- `packages/web/src/components/settings-dialog.tsx` — display-name input.
- `packages/web/src/lib/ws-client.ts` — `displayName` param → `name` query.
- `packages/web/src/stores/session-store.ts` — thread `displayName` through.
- `packages/web/src/lib/event-mapper.ts` — pass `actor` through.
- Timeline / Conversation components — attribution chip.
- Corresponding test files.
