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

## Design

### 1. Identity on the wire (per-socket)

Identity rides the existing WebSocket upgrade connection — no new message type.

- The web client appends `?name=<display name>` to the upgrade URL, alongside the
  existing `?token=` and `?cursor=N`.
- On `acceptWebSocket`, the Orchestrator reads `name` from the query string and stores it
  on the socket via `ws.serializeAttachment({ name })`, so it survives DO hibernation.
- Missing / blank name → falls back to `"Anonymous"`.
- Changing a name = reconnect (cheap; cursor replay already handles reconnection).

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

The existing state machine already rejects invalid transitions (e.g. a second `approve`
once the session has left `awaiting_approval`). We make that rejection name the winner:

- When a decision lands (approve / refine / abort succeeds), store the actor as
  `last_decider` in `session_meta`.
- When a later decision is rejected because the state already moved, the rejection
  `error`/`status` event carries `actor: <last_decider>` and a friendly message, e.g.
  `"Alice already approved this plan."` (fall back to the generic
  `"Cannot approve in state: executing"` when `last_decider` is unknown).

No locking, no claim protocol — the single-threaded DO + state machine guarantees a
single winner.

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

## Testing

- **Shared / contract:** schema accepts `actor`; events round-trip through the lenient
  `PersistedDOToCLIEventSchema`.
- **Orchestrator (unit):** two simulated `cli` sockets with different attached names;
  first `approve` wins and emits its `actor`; second is rejected naming the winner;
  `refine` and `abort` carry their actor; missing name → `Anonymous`.
- **Event-mapper:** events with and without `actor` map correctly.
- **ws-client:** `buildWebSocketUrl` appends `name` when set, omits it when empty
  (existing `session-store.test.ts` URL assertion updated accordingly — URL unchanged
  when name empty).
- **Web UI:** attribution chip renders when `actor` is present, absent otherwise;
  Settings persists and reloads `displayName`.

## Files touched (anticipated)

- `packages/shared/src/messages-cli.ts` — `actor?` on status/error schemas.
- `packages/worker/src/orchestrator.ts` — read name on accept, store attachment, stamp
  actor in handlers, `last_decider` in `session_meta`.
- `packages/web/src/lib/config.ts` — `displayName` field.
- `packages/web/src/components/settings-dialog.tsx` — display-name input.
- `packages/web/src/lib/ws-client.ts` — `displayName` param → `name` query.
- `packages/web/src/stores/session-store.ts` — thread `displayName` through.
- `packages/web/src/lib/event-mapper.ts` — pass `actor` through.
- Timeline / Conversation components — attribution chip.
- Corresponding test files.
