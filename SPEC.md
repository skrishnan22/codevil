# Codevil — Design Specification

**Date:** 2026-04-18
**Status:** Draft
**Inspiration:** [OnePay Tokki](https://www.onepay.com/newsroom/tokki), [Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent)

---

## Overview

Codevil is a self-hosted AI coding agent platform. Users describe a task in natural language, Codevil plans the implementation, gets approval, executes the code changes in a sandboxed environment, verifies the result, and opens a pull request.

The system is designed as a personal tool (Phase A) with an architecture that naturally scales to team use (Phase B) and open-source distribution (Phase C).

## Architecture

Three components:

```
CLI (thin client)
  │
  │ HTTPS + WebSocket
  │ Bearer token (API key)
  │
  ▼
Worker (thin router on Cloudflare edge)
  │
  │ Creates/routes to Durable Object per session
  │
  ▼
Durable Object (orchestrator — one per task session)
  │
  │ WebSocket
  │
  ▼
Cloudflare Sandbox (ephemeral Linux container)
  └── Pi SDK (coding agent engine, imported as library)
```

### CLI

- Thin TypeScript client. Installed via npm (`npx codevil` or global install).
- Sends task requests to the Worker, upgrades to WebSocket for streaming.
- Renders Pi's progress events (file reads, writes, bash commands) in real-time.
- Renders the plan as markdown for user approval.
- Supports conversational refinement during the approval phase.
- Displays final PR link. Does not render code diffs — code review happens on GitHub.
- Configuration stored in `~/.codevil/config`.

### Session Lifecycle

A session maps 1:1 to a task. Each `codevil run` creates one session.

**Session creation flow:**

1. CLI sends `POST /sessions` with `{ prompt, repo }` (repo URL from `--repo` flag). No session ID — this is a new session.
2. Worker validates the API key, generates a session ID (`ses_abc123`).
3. Worker creates a DO instance: `env.ORCHESTRATOR.idFromName("ses_abc123")`.
4. Worker returns the session ID and a WebSocket URL: `wss://codevil.../sessions/ses_abc123/ws`.
5. CLI connects to the WebSocket with `?cursor=0` (start from beginning). Session ID and last-seen cursor are held in memory for the CLI process lifetime. On reconnect, CLI passes `?cursor={last_seen}` to replay only missed events.
6. Session runs to completion (or failure/abort). CLI process exits.

**Session ID is not persisted by the CLI.** A session is scoped to one CLI process invocation. No temp files, no active-session tracking. The DO persists all state — the CLI is stateless. If the CLI process dies, the session ID is lost, but the DO continues running the task to completion. Reconnecting to orphaned sessions is a Phase B feature (`codevil resume`).

**Multiple CLI instances:** Each `codevil run` creates an independent session with its own DO and sandbox. Two terminals can run tasks against the same repo concurrently — they produce separate branches and PRs. Merge conflicts are the user's responsibility, same as two developers working in parallel.

**Multiple clients on one session:** The DO accepts multiple WebSocket connections per session. All clients subscribe to the same event log. This enables a future dashboard to watch a CLI-initiated session in real-time.

### Worker (Cloudflare Worker)

- Stateless HTTP entrypoint. Deployed via `wrangler deploy`.
- Validates API key against stored Cloudflare secret on every request — both `POST /sessions` and WebSocket upgrades at `/sessions/:id/ws`. Session ID alone is never sufficient for access.
- Generates a session ID on `POST /sessions`, creates/routes to a DO instance keyed to that ID.
- Serves authenticated WebSocket upgrade requests at `/sessions/:id/ws`, forwarding to the corresponding DO.
- No business logic — pure routing and auth.

### Orchestrator (Cloudflare Durable Object)

- One instance per task session, single-threaded, addressable by session ID.
- Manages the full task lifecycle as a state machine.
- Persists an ordered event log to its built-in SQLite storage.
- Maintains WebSocket connections to both the CLI and the sandbox.
- Handles reconnection: if the CLI's WebSocket drops (network blip, Wi-Fi switch), the DO keeps running the task. The CLI process still holds the session ID in memory, reconnects, and replays missed events from a cursor position.
- If the CLI process itself dies (terminal closed, crash), the session ID is lost. The DO keeps running to completion — the task still produces a PR. Reconnecting to an orphaned session requires `codevil resume` (Phase B).
- The CLI is a view into the session, not a requirement for the session to run.

### Sandbox (Cloudflare Sandbox)

- Ephemeral Linux container provisioned per task session.
- Pre-built container image with: Node.js, pnpm, Git, `gh` CLI, Pi SDK.
- Repo is cloned fresh at session start via `git clone`.
- Pi SDK is imported as a library (SDK mode, not CLI/RPC mode).
- A single entrypoint process runs inside the sandbox:
  - Holds the Pi `AgentSession` instance.
  - Connects to the DO via WebSocket.
  - Receives instructions (plan, execute, refine) from the DO.
  - Subscribes to Pi's `AgentEvent` stream and forwards all events to the DO in real-time.
- Destroyed immediately when the session ends (approved, aborted, or failed).

## Coding Engine: Pi SDK

Pi is a minimal, extensible coding agent by Mario Zechner. Codevil uses Pi as a library via its SDK mode — not as a CLI subprocess.

### Why Pi

- Small enough to read and understand end-to-end.
- Four core tools: `read`, `write`, `edit`, `bash`. Plus built-in `readOnlyTools` set (`read`, `grep`, `find`, `ls`) for safe exploration.
- Model-agnostic: supports 15+ LLM providers out of the box.
- Extensible via TypeScript extensions, skills, and custom tools.
- SDK mode designed for exactly this use case — embedding Pi in a larger platform.
- Cost and token tracking built in.

### SDK Integration

```typescript
import {
  createAgentSession,
  createReadOnlyTools,
  createCodingTools,
} from '@mariozechner/pi-coding-agent';

const cwd = '/workspace';  // cloned repo

// Start with read-only tools — plan phase cannot modify the repo
const { session } = await createAgentSession({
  cwd,
  model: getModel('anthropic', 'claude-sonnet-4-6'),
  tools: createReadOnlyTools(cwd),  // read, grep, find, ls — no bash, edit, write
  sessionManager: SessionManager.inMemory(),
});

// Subscribe to all events for real-time streaming to DO
session.agent.subscribe((event) => {
  websocket.send(JSON.stringify(event));
});

// Plan phase — agent explores with read-only tools
await session.prompt("Explore this repo and create a plan for: add rate limiting");
```

### Event Streaming

Pi emits fine-grained `AgentEvent` types during the agent loop:

| Event | Description |
|---|---|
| `agent_start` / `agent_end` | Session lifecycle |
| `turn_start` / `turn_end` | Each LLM response cycle |
| `message_start` / `message_update` / `message_end` | Streaming LLM output |
| `tool_execution_start` | Tool call initiated (tool name, args) |
| `tool_execution_update` | Partial tool result (streaming) |
| `tool_execution_end` | Tool call completed (result, success/error) |

These events are forwarded from sandbox → DO → CLI for real-time progress display.

### Model and Tool Switching Mid-Session

Pi supports switching both the model (`AgentSession.setModel()`) and the active tool set (`AgentSession.setActiveToolsByName()`) at any point mid-session. Changes take effect on the next agent turn. Codevil uses this to enforce the plan → approve → execute boundary:

```typescript
// Plan phase — read-only tools, cheaper model
// (session was created with createReadOnlyTools — see above)
await session.prompt("Explore this repo and create a plan for: ...");

// User approves...

// Execution phase — unlock full tools, switch to stronger model
session.setActiveToolsByName(["read", "bash", "edit", "write"]);
await session.setModel(getModel('anthropic', 'claude-opus-4-6'));
await session.prompt("Execute this approved plan...");
```

This is not a system instruction asking the model to behave — `write`, `edit`, and `bash` are not in the tool list sent to the LLM during planning. The model cannot call tools that don't exist in its context. The model swap handles re-clamping thinking level to the new model's capabilities automatically.

## Agent Pattern: Plan → Approve → Execute

Hybrid approach: Pi plans first, user approves, then Pi executes with a tool loop.

### Plan Phase

Pi runs with **read-only tools only** (`read`, `grep`, `find`, `ls`). No `bash`, `edit`, or `write` tools are available — the model cannot modify the repo during planning, regardless of prompt injection or model misbehavior.

Pi receives the user's prompt with a plan-mode system instruction:

> "You are in PLAN MODE. Explore this repository and create a detailed plan for: {prompt}. Only output the plan as structured markdown."

Pi uses its read-only tools to explore the codebase and produces a structured markdown plan. The plan is streamed back to the CLI.

### Approval Phase

The user reviews the plan in the CLI and can:

- **Approve** (`y`) — proceed to execution.
- **Abort** (`n`) — kill the session.
- **Refine** (type feedback) — Pi revises the plan based on user input.

Refinement is conversational — the user gives natural language feedback ("use redis instead of in-memory", "skip the migration step") and Pi updates the plan. Capped at 5 refinement rounds to prevent infinite loops.

### Execution Phase

After approval, the DO tells the sandbox to unlock the full tool set. The sandbox calls `session.setActiveToolsByName(["read", "bash", "edit", "write"])` — enabling write access only after explicit user approval.

Pi receives the approved plan with an execute-mode instruction:

> "Execute this plan step by step. After each step, run any available tests/lints."

Pi makes code changes, creates files, installs dependencies, and runs verification — all streamed as events.

### Verification

Pi runs whatever the repo already has: test suites, linters, type checkers. Pi discovers these by exploring `package.json` scripts, `Makefile` targets, and CI configuration. No custom verification config required.

If verification fails, Pi automatically retries — up to 5 attempts. Each attempt's errors and fixes are captured in the event log. After 5 failed attempts, the session escalates to the user with full error context.

### Output

On successful verification and user approval:

1. Pi creates a branch: `codevil/{task-slug}-{timestamp}`
2. Commits all changes with a descriptive message.
3. Pushes the branch via credential broker.
4. Opens a draft PR via `gh pr create --base {default_branch}` with the approved plan as the PR body. The default branch was discovered at clone time.
5. PR URL is streamed back to the CLI.

Code review happens on GitHub, not in the CLI.

## State Machine

```
initializing
  → provisioning_sandbox
  → cloning_repo
  → planning
  → plan_ready
  → awaiting_approval ←→ refining (up to 5 rounds)
  → executing
  → verifying ←→ retrying (up to 5 attempts)
  → creating_pr
  → completed

Any state → failed (unrecoverable error or user abort)
Any state → timed_out (max_time exceeded)
Any state → cost_exceeded (max_cost exceeded)
```

All state transitions are persisted to the DO's SQLite as an ordered event log.

## Communication Protocol

### CLI ↔ DO (WebSocket)

Bidirectional. DO streams events to CLI, CLI sends user input (approval, feedback, abort).

**Authentication:** Every WebSocket upgrade requires a valid API key (same Bearer token as `POST /sessions`). The Worker validates before forwarding to the DO. A session ID without the API key cannot connect.

**Multi-client control:** In Phase A (single user), all authenticated clients have equal control — if you have the API key, you can send any control message. The DO is single-threaded, so concurrent messages are serialized. The state machine rejects invalid transitions (e.g., `approve` when not in `awaiting_approval`). Multi-client role separation (controller vs observer) is a Phase B concern behind Cloudflare Access.

**DO → CLI events:**
```typescript
{ type: "session_created", session_id: string }
{ type: "status", message: string }  // "Cloning repo...", "Starting agent..."
{ type: "clone_progress", line: string }
{ type: "phase", phase: "planning" | "executing", model: string }
{ type: "agent_event", event: AgentEvent }  // forwarded from Pi
{ type: "plan_ready", plan: string, cost: CostInfo, refinement_round: number }
{ type: "verification_failed", attempts: number, last_error: string }
{ type: "complete", pr_url: string }
{ type: "error", message: string }
```

**CLI → DO messages:**
```typescript
{ type: "approve" }
{ type: "abort" }
{ type: "refine_plan", feedback: string }
```

### DO ↔ Sandbox (WebSocket)

Bidirectional. DO sends instructions, sandbox streams Pi events.

**DO → Sandbox:**
```typescript
{ type: "init", repo: string }  // repo URL — sandbox clones and discovers default branch
{ type: "plan", prompt: string, model: string }
{ type: "execute", plan: string, model: string }
{ type: "refine_plan", feedback: string }
{ type: "create_pr", branch: string, commit_message: string, pr_title: string, pr_body: string }
```

**Sandbox → DO:**
```typescript
{ type: "agent_event", event: AgentEvent }  // real-time Pi events
{ type: "plan_ready", plan: string, cost: CostInfo }
{ type: "execution_complete", cost: CostInfo }
{ type: "credential_request", host: string }  // git credential helper needs auth
{ type: "pr_created", url: string }
{ type: "error", message: string }
```

**DO → Sandbox (credential response):**
```typescript
{ type: "credential_response", token: string }  // one-shot, not cached by sandbox
```

### Resilience

- **DO ↔ Sandbox WebSocket drops:** Sandbox and Pi continue running. DO auto-reconnects. Pi's output is logged to a file inside the sandbox as a fallback — on reconnect, DO reads the log to catch up on missed events.
- **CLI ↔ DO WebSocket drops (network blip):** DO continues running the task. CLI reconnects with `?cursor={last_seen}` and replays only missed events. If the CLI process itself dies, the DO still runs to completion — the task produces a PR regardless. Reconnecting to orphaned sessions requires `codevil resume` (Phase B).
- **DO is the source of truth.** Every event is redacted (see *Secret Isolation & Event Redaction*) then appended to the DO's SQLite. Any client subscribes from a cursor position. This also enables future multi-client support (CLI + dashboard watching the same session).

## Platform: Cloudflare

All infrastructure runs on Cloudflare. One account, one billing, one deployment.

| Layer | Cloudflare Product |
|---|---|
| API / routing | Workers |
| Orchestrator (stateful) | Durable Objects |
| Sandbox execution | Sandboxes (Containers) |
| Secrets storage | Workers Secrets |
| Event log / session history | Durable Object built-in SQLite |
| Future: artifact storage | R2 |
| Future: async jobs | Queues |
| Future: team auth | Cloudflare Access (Zero Trust) |

### Why Cloudflare

- Active CPU billing on sandboxes — idle time is free. Critical for keeping costs low.
- Persistent sandboxes with snapshot support (upgrade path for faster restarts).
- Durable Objects provide single-threaded, addressable stateful processes with built-in SQLite and WebSocket hibernation.
- One ecosystem: no gluing 6 services from 4 vendors.
- Global edge distribution comes free for Phase B/C.
- Self-hosted: user deploys to their own CF account. No multi-tenant billing to build.

## Authentication & Secrets

### CLI ↔ Backend Auth

- Simple API key. Set by the user during deploy via `wrangler secret put CODEVIL_API_KEY`.
- CLI sends it as a Bearer token on every request. Stored in `~/.codevil/config`.
- No OAuth, no identity provider. The Cloudflare account is the trust boundary.
- For team use (Phase B), users can add Cloudflare Access in front — their infra decision, not baked into the core.

### GitHub Access

- User provides a GitHub PAT during deploy via `wrangler secret put GITHUB_PAT`.
- Stored as a Cloudflare secret (encrypted, never in DO SQLite).
- **Never injected as an environment variable.** The sandbox runs a git credential helper that requests credentials from the DO over the internal WebSocket on demand:
  1. Git needs auth → credential helper sends `{ type: "credential_request", host }` to DO.
  2. DO validates the host matches the expected repo origin, responds with `{ type: "credential_response", token }`.
  3. Credential helper returns the token to git. Token is not cached by the helper.
- Used for `git clone`, `git push`, and `gh pr create`.
- The PAT is only transiently available during git operations — it never sits in the sandbox's shell environment, filesystem, or process environment.

### LLM API Keys

- Bring Your Own Key (BYOK). User provides their key during deploy via `wrangler secret put LLM_API_KEY`.
- Stored as a Cloudflare secret alongside the GitHub PAT.
- **Not injected as a shell environment variable.** The DO writes the key to a tmpfs file (`/run/secrets/llm_key`) inside the sandbox at creation time. The entrypoint process reads the file, loads the key into Pi's in-memory config, then unlinks the file.
- The key lives in process memory only — not discoverable via `printenv`, `env`, or `/proc/self/environ`.
- No proxy billing. User's key, user's cost.
- **Acknowledged risk:** A compromised dependency with arbitrary code execution could extract the key from process memory. Mitigations: sandboxes are ephemeral (destroyed on session end), and users should use API keys with provider-side spend limits.

## Configuration

### User Config (`~/.codevil/config`)

```yaml
endpoint: https://codevil.<account>.workers.dev
api_key: cdv_xxxxxxxxxxxx

defaults:
  plan_model: claude-sonnet-4-6
  exec_model: claude-sonnet-4-6
  provider: anthropic
  max_cost: $2
  max_time: 15m
  max_steps: 50
```

All defaults are overridable per run via CLI flags:
```bash
codevil run "refactor auth" --plan-model haiku --exec-model opus --max-cost 10 --max-time 30m
```

### Project Config

No custom config format. Pi already reads `CLAUDE.md`, `agents.md`, and similar files from the repo root. This is a solved problem — don't reinvent it.

## Repo Structure

pnpm workspaces monorepo. No Turborepo — not needed at this scale. Add it if/when builds feel slow.

```
codevil/
  packages/
    cli/              # CLI tool (npm package: codevil)
      src/
        index.ts      # entry point
        config.ts     # ~/.codevil/config management
        commands/
          run.ts      # codevil run "prompt"
          init.ts     # codevil init (local config only, no secret mutation)
        ws-client.ts  # WebSocket client to DO
        renderer.ts   # terminal output (progress, plan, status)
    worker/           # Cloudflare Worker + Durable Object
      src/
        index.ts      # Worker entrypoint (router + auth)
        orchestrator.ts  # Durable Object class
        sandbox.ts    # Sandbox provisioning and communication
        types.ts      # Shared event/message types
      wrangler.toml   # Cloudflare deployment config
    shared/           # Shared types and constants
      src/
        events.ts     # Event type definitions
        messages.ts   # WebSocket message schemas
        config.ts     # Config schema
    sandbox-image/    # Dockerfile / build for the sandbox container image
      Dockerfile
      entrypoint.ts   # Pi SDK integration, WebSocket server
  pnpm-workspace.yaml
  package.json
```

## Setup Flow

### First-Time Deploy (Backend)

Secrets are stored via `wrangler secret put` — the standard Cloudflare mechanism. Wrangler authenticates with the user's Cloudflare account, which is the bootstrap admin credential. The deployed Worker and CLI never have permission to mutate secrets.

```bash
git clone github.com/user/codevil
cd codevil
pnpm install
cd packages/worker

# User authenticates wrangler with their CF account
wrangler deploy
# → Deployed to https://codevil.<account>.workers.dev

# Store secrets (wrangler prompts for each value)
wrangler secret put CODEVIL_API_KEY      # user-chosen API key for CLI auth
wrangler secret put GITHUB_PAT           # GitHub Personal Access Token
wrangler secret put LLM_API_KEY          # Anthropic/OpenAI/etc API key
wrangler secret put LLM_PROVIDER         # "anthropic", "openai", etc.
```

### First-Time CLI Setup

`codevil init` only writes the local config file. It does not store secrets — that was done during deploy via wrangler.

```bash
npx codevil init
# → Enter your Codevil backend URL: https://codevil.<account>.workers.dev
# → Enter your API key: cdv_xxx (the key you set as CODEVIL_API_KEY above)
# → Default planning model [claude-sonnet-4-6]:
# → Default execution model [claude-sonnet-4-6]:
# → Config saved to ~/.codevil/config
```

### Running a Task

```bash
codevil run "add rate limiting to the API" --repo github.com/user/my-api
```

## End-to-End Task Lifecycle

1. **CLI** reads `~/.codevil/config`, sends `POST /sessions` with `{ prompt, repo }` to Worker.
2. **Worker** validates API key, creates a Durable Object instance.
3. **DO** upgrades to WebSocket with CLI, provisions a Cloudflare Sandbox.
4. **DO** writes LLM API key to sandbox tmpfs (`/run/secrets/llm_key`), sends `{ type: "init", repo }`.
5. **Sandbox** starts, clones the repo via credential broker (`git clone`), discovers default branch via `gh repo view --json defaultBranchRef`. Progress streams to CLI.
6. **Sandbox** initializes Pi SDK with plan model, subscribes to events.
7. **Pi** explores the codebase and produces a plan. Events stream: DO → CLI.
8. **CLI** renders the plan. User reviews.
9. **User** refines conversationally (up to 5 rounds) or approves.
10. **DO** tells sandbox to switch to exec model and execute.
11. **Pi** executes the plan step by step, making code changes.
12. **Pi** runs the repo's tests/lints. Retries up to 5 times on failure.
13. **Verification passes.** DO tells sandbox to create branch, commit, push, open PR.
14. **Sandbox** runs `gh pr create`. PR URL streams back to CLI.
15. **CLI** displays the PR link. Session complete.
16. **DO** persists final state, destroys sandbox, hibernates.

## Cost Controls

Three guardrails, all configurable via `~/.codevil/config` and overridable per run:

| Guard | Default | Behavior on breach |
|---|---|---|
| `max_cost` | $2 | Save state, report to user, user decides to extend or abort |
| `max_time` | 15 minutes | Same |
| `max_steps` | 50 tool calls | Same |

Fail open with state preserved — never hard-kill with work lost.

## Secret Isolation & Event Redaction

### The Problem

Pi has a `bash` tool. When Pi runs a shell command, the command's stdout/stderr becomes the tool result, which becomes an `AgentEvent`, which gets persisted to the DO's SQLite event log and streamed to every connected client. If a secret value appears anywhere in tool output, it propagates through the entire chain:

```
Pi runs bash("printenv") or a malicious dependency logs env vars
  → stdout contains secret values
  → Pi emits: { type: "tool_execution_end", result: "...secret..." }
  → Sandbox forwards event to DO
  → DO persists to SQLite event log
  → DO forwards to CLI and any other connected client
  → Secret is now in: DO's database, CLI terminal, any future client replaying the log
```

This can happen without malicious intent — Pi exploring the repo, a build script logging diagnostics, or a test dumping error context.

### Event Redaction Layer

The DO applies a redaction pass to every event before persisting or forwarding it. The DO already holds the actual secret values (read from CF secrets at session start), so it can do both exact-match and pattern-based redaction:

```typescript
function redactEvent(event: AgentEvent, knownSecrets: string[]): AgentEvent {
  let serialized = JSON.stringify(event);

  // Exact-match: scrub any value that matches an injected secret
  for (const secret of knownSecrets) {
    serialized = serialized.replaceAll(secret, '[REDACTED]');
  }

  // Pattern-match: known secret formats as a safety net
  serialized = serialized.replace(/ghp_[A-Za-z0-9_]{36,}/g, '[REDACTED]');
  serialized = serialized.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  serialized = serialized.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]');

  return JSON.parse(serialized);
}
```

Exact-match catches secrets regardless of format. Pattern-match is a safety net for secrets the DO doesn't know about (e.g., a `.env` file in the repo).

### Event Log Limits

| Guard | Default | Behavior |
|---|---|---|
| Event log retention | 7 days after session completion | DO prunes on wake; hibernated DOs pruned via scheduled Worker |
| Event payload max size | 64 KB per event | Tool outputs truncated with `[truncated, {n} bytes total]` |
| Bash stdout capture | 32 KB per command | Matches Pi's existing truncation; excess logged to sandbox-local file only |

### Defense in Depth Summary

| Layer | What it protects against |
|---|---|
| Git credential broker (no PAT in env) | `printenv`, env var scraping, shell history leaks |
| LLM key via tmpfs (unlinked after read) | `printenv`, `/proc/self/environ`, casual env dumps |
| Event redaction (exact + pattern match) | Secrets leaking through tool output into persistent storage |
| Event log retention + size limits | Stale secrets persisting indefinitely, oversized payloads |
| Ephemeral sandboxes | Blast radius limited to one session — no persistent compromise |

## Future Considerations (Phase B/C)

Not in scope for initial build, but the architecture supports:

- **Web dashboard** — Another client subscribing to the DO's event log. Real-time progress, plan viewer/editor, session history.
- **Slack/chat integration** — Thin adapter that translates Slack messages to DO WebSocket messages.
- **Sandbox snapshots** — Snapshot after clone, warm-start future sessions. Solves clone time at the cost of cache invalidation logic.
- **Multiple concurrent sessions** — Each session is its own DO. Already isolated by design.
- **Session resume** — `codevil resume` lists previous/active sessions (queried from Worker via `GET /sessions`), user picks one to reconnect. CLI replays missed events from the DO's event log cursor.
- **Team auth** — Cloudflare Access / Zero Trust in front of the Worker.
- **Session history/analytics** — Query the DO's SQLite event logs for usage patterns, costs, success rates.

---

## Reference Links

### Inspiration

- [OnePay Tokki — Developer Agent Announcement](https://www.onepay.com/newsroom/tokki)
- [Ramp Inspect — Why We Built Our Background Agent](https://builders.ramp.com/post/why-we-built-our-background-agent)

### Pi SDK

- [Pi Mono Repo (GitHub)](https://github.com/badlogic/pi-mono)
- [Pi Coding Agent Package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [Pi Coding Agent README / SDK docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [Pi npm package](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- Local source verified at: `/Users/skrishnan/development/pi-mono/packages/coding-agent/src/core/sdk.ts` (SDK entry), `agent-session.ts` (event system, model switching), `../agent/src/types.ts` (AgentEvent types)

### Cloudflare Platform

- [Cloudflare Sandboxes GA — Blog](https://blog.cloudflare.com/sandbox-ga/)
- [Cloudflare Sandbox SDK Documentation](https://developers.cloudflare.com/sandbox/)
- [Dynamic Workers (V8 isolates) — Blog](https://blog.cloudflare.com/dynamic-workers/)
- [Cloudflare Agents Week 2026 — Overview](https://www.cloudflare.com/agents-week/)
- [Cloudflare Agents Week — Updates](https://www.cloudflare.com/agents-week/updates/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)

### Verified During Design

| Question | Finding | Source |
|---|---|---|
| Can Pi stream intermediate tool events? | Yes — `AgentEvent` includes `tool_execution_start/update/end` with args and results. Subscribe via `agent.subscribe()`. | `pi-mono/packages/agent/src/types.ts:295-310` |
| Can Pi switch models mid-session? | Yes — `AgentSession.setModel(model)` switches model, re-clamps thinking level. | `pi-mono/packages/coding-agent/src/core/agent-session.ts:1371-1387` |
| Do CF Sandboxes support persistent state? | Yes — snapshots capture full disk state, restore in ~2s warm start. | [Sandbox GA blog](https://blog.cloudflare.com/sandbox-ga/) |
| CF Sandbox pricing model? | Active CPU only — idle sandboxes are free. | [Sandbox GA blog](https://blog.cloudflare.com/sandbox-ga/) |
| CF Sandbox TS SDK? | `@cloudflare/sandbox` — supports `exec`, `gitClone`, `writeFile`, `terminal`, `watch`, `snapshot`. | [Sandbox SDK docs](https://developers.cloudflare.com/sandbox/) |
| DO WebSocket hibernation? | Yes — DO sleeps when idle, wakes on message. No cost when hibernated. | [Durable Objects docs](https://developers.cloudflare.com/durable-objects/) |
