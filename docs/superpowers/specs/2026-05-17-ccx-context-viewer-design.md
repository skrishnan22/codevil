# ccx — Claude Code Context Viewer

A standalone Bun CLI and browser-based viewer for visualizing what's in the
context window of a Claude Code session at any point in time. Live-tails the
active session, reconstructs the prompt structure from CC's transcript JSONL,
and exposes a budget-first breakdown with drill-down, timeline, and historical
session inspection.

Claude Code already has a `/context` slash command that prints a one-shot
snapshot in the terminal. `ccx` is its persistent, browser-based cousin: same
underlying data, but live, drillable, timeline-aware, and able to compare
across sessions.

## Goals

1. **Token accounting** — show how many tokens each source (system prompt,
   CLAUDE.md, skills, MCP, tool defs, history) currently consumes.
2. **Audit what the model sees** — confirm CLAUDE.md actually loaded, the
   right skills are active, no surprise injections.
3. **Debug behavior** — replay a session's context evolution turn by turn to
   diagnose unexpected outputs.

## Non-goals

- Rule attribution ("which CLAUDE.md rule influenced this decision?"). Not
  reliably possible without changes to CC's prompt. Future work.
- Editing/intercepting context. Read-only viewer.
- Replacing CC's own `/context` command. Complementary.
- Recording context independently. JSONL files on disk are the source of
  truth.

## Architecture

A single Bun process combining HTTP server, file watcher, tokenizer, and the
SPA bundle. Bun's HTML imports serve the React UI directly — no Vite, no
separate build step.

```
ccx (Bun process)
├── watcher  — fs.watch + 1s stat heartbeat on
│              ~/.claude/projects/<encoded-cwd>/*.jsonl
├── parser   — incremental JSONL → ContextItem stream
├── model    — in-memory SessionSnapshot per session
├── tokenizer — gpt-tokenizer (cl100k_base, pure JS)
└── Bun.serve
    ├── /            — SPA shell (HTML import)
    ├── /api/...     — snapshots, session list
    └── /events      — SSE: live deltas to the SPA
```

Browser uses `EventSource('/events')` for live updates; auto-reconnects on
drop. Server replays the latest snapshot on reconnect.

## Data ingestion

### Transcript location

`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, where `<encoded-cwd>`
replaces `/` with `-`. By default `ccx` resolves cwd → directory → newest
JSONL.

### File reading

```ts
class JsonlTail {
  offset = 0
  inode: number | null = null
  buffer = ""
  async readAvailable() {
    const stat = await fs.stat(this.path)
    if (this.inode && stat.ino !== this.inode) this.reset()  // rotated
    if (stat.size < this.offset) this.reset()                // truncated
    this.inode = stat.ino
    if (stat.size === this.offset) return []
    const buf = await fs.readFile(this.path).slice(this.offset)
    this.offset = stat.size
    return this.tokenize(buf.toString("utf8"))
  }
  tokenize(chunk: string): string[] {
    const text = this.buffer + chunk
    const lines = text.split("\n")
    this.buffer = lines.pop() ?? ""
    return lines.filter(Boolean)
  }
}
```

Read triggers come from `fs.watch` (low-latency) and a 1-second `stat`
heartbeat (safety net for Bun's known macOS watch-event drops). Both go
through a debounced scheduler so two reads never run concurrently.

### Event dispatch

Each parsed JSON line routes by `type` (or `attachment.type`). Top-level types
encountered in real transcripts:

| `type` (top-level)                | What it represents                                  | Effect on model                                                                  |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `last-prompt`, `permission-mode`  | Session metadata                                    | Updates header state. No ContextItem.                                            |
| `attachment`                      | Hook outputs, deltas, file edits, reminders         | Routed to attachment dispatch (next table)                                       |
| `user`                            | A user-typed prompt                                 | Adds `history` ContextItem                                                       |
| `assistant`                       | An assistant turn (carries `usage`)                 | Adds `history` ContextItem per content block; updates session `usage`            |
| `tool_use` (top-level, rare)      | Synthesized tool call                               | Child of nearest assistant ContextItem                                           |
| `tool_result`                     | Tool output returned to the model                   | Adds `history` ContextItem, parented to the originating tool_use                 |
| `system`                          | Mid-session system message                          | Adds `system` ContextItem                                                        |
| `image`                           | Image attachment                                    | History sub-item; tokens estimated from dimensions                               |
| `thinking`                        | Extended-thinking block (sometimes top-level)       | Child of nearest assistant                                                       |

Attachment sub-types (`attachment.type`):

| `attachment.type`                       | Effect                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `hook_success` (`SessionStart`)         | Parse `stdout` JSON → `hookSpecificOutput.additionalContext`; classify into `skill` / `system` / `mcp` items |
| `hook_additional_context`               | Mid-session injected block. Bucketed by content                                                         |
| `skill_listing`                         | Update available-skills catalog. Catalog (descriptions only) → `skill` bucket. Skill **bodies** load on demand via the `Skill` tool — track those separately as new `skill` items when the tool fires. |
| `deferred_tools_delta`                  | `addedNames` → add `tool_def` items (sub-category `deferred`); `removedNames` → mark removed. CC's `/context` distinguishes "System tools" / "System tools (deferred)" / "MCP tools (deferred)" — we mirror those sub-categories under `tool_def` and `mcp`. |
| `tools_changed`                         | Recompute the tool_def set                                                                              |
| `mcp_instructions_delta`                | `addedNames`+`addedBlocks` → add `mcp` items; `removedNames` → remove                                  |
| `agent_listing_delta`                   | `addedTypes`+`addedLines` → `system` sub-bucket items                                                  |
| `task_reminder`                         | Injected "task tools haven't been used" reminder. `system` bucket                                       |
| `messages_changed`                      | Compaction event. Emits timeline entry; marks evicted history items                                     |
| `previous_message_not_found`            | Confirms eviction of referenced message                                                                |
| `file-history-snapshot`                 | Pre-edit snapshot. Doesn't enter context. Used for edit-timeline only                                  |
| `edited_text_file`, `file_unchanged`    | Annotates tool_result token counts                                                                     |
| `queue-operation`, `queued_command`, `command_permissions`, `permission-mode`, `direct`, `create`, `update`, `ai-title`, `date_change` | IDE bookkeeping. No ContextItem |
| `ultrathink_effort`                     | Metadata only                                                                                          |
| _unknown_                               | Bucketed as `unknown` with raw payload; counted; surfaced in Timeline                                  |

### Per-turn order of operations

```
parseLine(line) {
  const evt = JSON.parse(line)
  const handler = dispatch[evt.type] ?? dispatch[evt.attachment?.type] ?? dispatch.unknown
  const { added, removed } = handler(evt, state)
  for (const item of added)   tokenize(item)
  for (const item of added)   state.items.set(item.id, item)
  for (const id   of removed) state.items.get(id)!.removedAt = evt.timestamp
  state.events.push({ kind, sourceItemIds, tokenDelta, timestamp: evt.timestamp })
}

afterAssistantTurn(msg) {
  state.lastUsage = msg.message.usage
  reconcile()
  emitSse("snapshot", state)
}
```

All handlers are pure `(event, state) → {added, removed}`. State mutation
happens in one place. Easy to unit-test against captured JSONL fixtures.

### Subagents (sidechains)

When `isSidechain: true`, the line routes into `state.subSessions[sidechainId]`
instead of `state.items`. The parent session's `history` bucket gets a single
`Subagent: <type>` placeholder ContextItem pointing to that sub-session by
id. Expanding it in the UI swaps the tree to show the subagent's transcript.

## Tokenizer

### Why no exact local tokenizer

Anthropic does not publish a public BPE tokenizer for Claude 3.x / 4.x.
`@anthropic-ai/tokenizer` on npm is for Claude 1/2 and not accurate for
current models. The only way to get exact counts locally is the
`messages.count_tokens` API.

### Layered strategy

**Layer 1 — `usage` from the JSONL (exact, free).** Every assistant message
records:
```json
"usage": { "input_tokens": 6, "cache_creation_input_tokens": 70302,
           "cache_read_input_tokens": 15336, "output_tokens": 167 }
```
`input + cache_creation + cache_read` is the exact prompt size Anthropic
counted. This is the ground-truth total.

**Layer 2 — `gpt-tokenizer` proxy for per-item counts.** Pure-JS port of
tiktoken `cl100k_base`. No native bindings. Runs identically in Bun and Node.
~10MB, loads <100ms. Empirically within ~5–15% of true Claude counts on
English text and code.

**Layer 3 — reconciliation, NOT rescaling.** The gap between sum-of-visible
items and `usage` is content we genuinely can't see (the base CC system
prompt, the env block, etc.). It gets its own bucket — `system_base` — rather
than being smeared across the visible buckets.

```
attributed_visible = Σ items.tokens     // gpt-tokenizer counts
actual             = usage.input + cache_creation + cache_read

if actual > attributed_visible:
    system_base = actual - attributed_visible   // unattributed remainder
    // No rescale; visible buckets keep raw proxy counts.

if actual < attributed_visible:
    // Compaction. Eviction walk; see below.
```

Bar total = `actual` (exact). Per-bucket = raw proxy counts for visible items
+ computed remainder for `system_base`. Per-bucket counts are marked `~` and
documented as proxy estimates.

**Layer 4 — `--accurate` flag.** Calls `messages.count_tokens` for each
visible item, eliminating proxy drift. Off by default.

**Fallback if `gpt-tokenizer` fails to load.** Pure `chars/4` heuristic with a
banner.

## Eviction / compaction

CC may compact older messages when nearing the model's context limit. We
detect this two ways:

1. `messages_changed` and `previous_message_not_found` attachment events
   appear in the JSONL when the message list mutates.
2. `attributed_visible` exceeding `actual` between two consecutive turns is a
   second signal even if no explicit event fires.

When detected:

```
walk history items oldest → newest:
  mark item as evicted: true
  attributed_remaining -= item.tokens
  if attributed_remaining ≈ actual: stop
emit Timeline event: { kind: "compaction", tokenDelta, evictedIds }
```

Evicted items stay visible in the tree, greyed out, with an "evicted at turn
N" tag. Reconciliation continues on non-evicted items only.

If `ratio = actual / attributed < 0.5` or `> 2.0`, attribution is too drifted
to trust. Fallback: show raw counts with an "attribution drift" warning;
diagnostic details logged to stderr.

## UI

### Layout

Single-window React SPA, ~900px wide, served by Bun. Header with session
picker + permission-mode chip + live indicator. Tab strip: **Current** /
**Timeline** / **Sessions**. Footer with live status and cache stats.

### Current tab (default)

- **Budget bar**: stacked horizontal bar showing `system_base / CLAUDE.md /
  skills / mcp / tool_defs / history` segments. Total = exact from `usage`.
  Reference scale = model's max context, resolved at session-open from a
  static `model → max_tokens` map (e.g., `claude-opus-4-7 → 1_000_000`). Map
  ships with the binary; unknown model falls back to 200_000 and shows a
  small "unknown model" badge.
- **Drill-down list**: each bucket is a collapsible row. Click `▸` to expand
  → children (e.g., individual skill names with their own sizes). `~` badge
  on `system_base` only.
- **Detail pane**: clicking a leaf opens a side/modal pane with the raw
  content (CLAUDE.md body, skill body, tool schema JSON, message text, tool
  result). Toggle raw/preview view.

### Timeline tab

Vertical event list, newest at top. Each entry shows timestamp, source-bucket
color dot, label, and token delta. Compaction events shown as a horizontal
divider annotated "context shrank by N tokens". Filter chips toggle bucket
visibility. Clicking an entry focuses the corresponding item in the Current
tree.

### Sessions tab

Table of all sessions in the project dir, newest first. Columns: started-at,
first user message snippet, total turns, peak context. Click to switch.

### Interactions

- Click bucket row → expand/collapse.
- Click child leaf → detail pane.
- Search box (⌘K) over all item labels.
- Keys: `1`/`2`/`3` switch tabs, `j`/`k` move rows, `enter` opens detail.

## CLI

```
ccx                              # tail most-recent session in cwd
ccx --port 7777                  # fixed port
ccx --no-open                    # don't auto-open browser
ccx --project /path/to/repo      # watch a different project's sessions
ccx --session <uuid>             # open a specific session
ccx --accurate                   # use count_tokens API for per-item counts
ccx --host 0.0.0.0               # for remote/containerized setups
ccx ls                           # list sessions in cwd's project, newest first
```

Subsequent `ccx` runs detect an existing listener on the chosen port (via
`~/.cache/ccx/<port>.lock`) and reuse the URL rather than starting a second
server. Per-project default port persisted in
`~/.cache/ccx/<project-hash>.port`.

Browser auto-opens via `open` / `xdg-open` / `start` based on platform.

## Error handling

| Condition                                        | Behavior                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| JSONL parse error on one line                    | Log to stderr, emit `parseError` timeline event, continue                 |
| File rotation / truncation                       | Reset offset to 0, re-ingest                                              |
| `fs.watch` drops events                          | 1s `stat` heartbeat triggers catch-up read                                |
| Tokenizer init failure                           | Fall back to `chars/4` with UI banner                                     |
| Unknown event type                               | Bucketed as `unknown`, raw payload viewable                               |
| Multiple concurrent sessions in same project     | Tracked simultaneously; "live" indicator follows most-recent write        |
| Long-running session, large transcript           | Kept in memory; timeline virtualized past ~500 entries                    |
| Empty project dir                                | Sessions tab shows "no sessions yet"; tail waits for first write          |
| Permission errors reading `~/.claude/projects/`  | Single clear error, exit non-zero                                         |
| SSE disconnect                                   | Browser auto-reconnects; server replays latest snapshot                   |
| Attribution drift (`ratio` < 0.5 or > 2.0)       | Show raw counts + "attribution drift" warning banner                      |

## Testing

| Layer                           | Approach                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Parser / model unit tests       | Fixture-driven: real JSONL captured from sessions (PII stripped). Assert per-bucket item counts, total reconciles vs `usage`, compaction events fire as expected. `bun test`. |
| Tokenizer wiring                | Snapshot tests on representative inputs (message, tool result, skill body). No exact-Anthropic assertions. |
| Watcher integration             | Temp dir + programmatic append. Assert in-memory model updates within ~100ms.       |
| SSE integration                 | In-process server + SSE client. Append to fixture; assert events arrive within deadline. |
| UI smoke test                   | One Playwright test against fixture-backed server. Renders bar, expands a bucket, opens detail pane. |

Not covered: visual polish, cross-platform watcher (auto-tested on dev's
host only), subagent edge cases at nesting depth > 2 (manual once, then
fixture-capture).

## Out of scope for v1

- Rule attribution (which CLAUDE.md rule influenced a decision). Considered
  via IDF keyword match / embedding similarity / polarity-aware parsing —
  none reliable enough for v1; honest "we don't know" is better than a noisy
  "we sort of know." Possible v2 via citation-by-instruction (SessionStart
  hook injects citation rule) — opt-in.
- Auto-launch via SessionStart hook. Possible v2; keep manual `ccx` for v1.
- Multi-project root view. Single-project per process for v1.
- Persistent on-disk storage of computed model. JSONL on disk is canonical.

## Open questions (deferred to plan stage)

- Exact React structure (component tree, state management library or not).
- Bundling for distribution — `bun build --compile` single-binary vs npm
  global install.
- Whether to ship the `~80MB` model dependency for the v2 embedding-based
  rule attribution feature, or punt.
