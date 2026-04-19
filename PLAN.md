# Codevil — Implementation Plan

**Created:** 2026-04-19
**Spec:** [SPEC.md](./SPEC.md)

---

## Approach

Build incrementally in vertical slices. Each slice produces a working piece that can be run, tested, and reviewed before moving on. No big-bang integration.

---

## Phase 1: Shared Types

Define the contracts that all packages implement against. No runtime code — just TypeScript types and schemas.

### Tasks

- [x] Initialize monorepo: `pnpm-workspace.yaml`, root `package.json`, `tsconfig` base
- [x] Create `packages/shared/` package
- [x] Define session state machine types (`SessionState`, valid transitions)
- [x] Define CLI ↔ DO WebSocket message types (both directions)
- [x] Define DO ↔ Sandbox WebSocket message types (both directions)
- [x] Define config schema (`~/.codevil/config`)
- [x] Define cost/guard types (`max_cost`, `max_time`, `max_steps`)

### Review checkpoint

Read through all types. Do they match the spec's protocol section? Can you trace a full session lifecycle through the type definitions?

---

## Phase 2: Worker + Durable Object Skeleton

HTTP router, auth, DO lifecycle, WebSocket upgrade. No sandbox — the DO manages state transitions and accepts WebSocket connections.

### Tasks

- [ ] Create `packages/worker/` package with `wrangler.toml`
- [ ] Worker entrypoint: `POST /sessions` (validate API key, generate session ID, create DO)
- [ ] Worker entrypoint: `GET /sessions/:id/ws` (validate API key, upgrade to WebSocket, forward to DO)
- [ ] Durable Object class: accept WebSocket connections, track cursor positions
- [ ] DO state machine: implement state transitions, reject invalid ones
- [ ] DO event log: append events to SQLite, support replay from cursor via `?cursor=N`
- [ ] Emit test events so a WebSocket client can verify the pipeline works

### Review checkpoint

Connect with `wscat` or a test script. Send approve/abort/refine messages and verify state transitions. Check that invalid transitions are rejected. Verify cursor-based replay works.

### Deploy checkpoint

`wrangler deploy` to your CF account. Verify auth works — requests without API key are rejected.

---

## Phase 3: CLI

Connect to the Worker, render events, handle the approval flow. Wire it to the DO skeleton from Phase 2.

### Tasks

- [ ] Create `packages/cli/` package, entry point `bin/codevil`
- [ ] `codevil init` — prompt for endpoint URL and API key, write `~/.codevil/config`
- [ ] `codevil run` — parse args (`--repo`, `--plan-model`, `--exec-model`, `--max-cost`, `--max-time`)
- [ ] WebSocket client: connect with Bearer token, handle reconnect with `?cursor=N`
- [ ] Renderer: display status events, clone progress, phase changes
- [ ] Renderer: display plan as markdown when `plan_ready` arrives
- [ ] Approval flow: prompt user for approve (`y`), abort (`n`), or refinement feedback
- [ ] Send `approve`, `abort`, `refine_plan` messages over WebSocket
- [ ] Display PR URL on `complete` event
- [ ] Handle `error` and `verification_failed` events gracefully

### Review checkpoint

Run `codevil run` against the deployed DO skeleton. See test events render in the terminal. Walk through the approval flow. Disconnect and reconnect — verify cursor replay shows missed events.

---

## Phase 4: Sandbox + Pi SDK Integration

The real agent. Pi explores with read-only tools, plans, and executes with full tools after approval.

### Tasks

- [ ] Create `packages/sandbox-image/` with Dockerfile (Node.js, pnpm, Git, gh CLI, Pi SDK)
- [ ] Sandbox entrypoint: connect to DO via WebSocket
- [ ] Handle `{ type: "init", repo }` — clone repo via credential broker, discover default branch with `gh repo view`
- [ ] Handle `{ type: "plan", prompt, model }` — create Pi `AgentSession` with `createReadOnlyTools()`, run plan prompt
- [ ] Subscribe to Pi `AgentEvent` stream, forward all events to DO
- [ ] Handle `{ type: "refine_plan", feedback }` — send refinement prompt to Pi
- [ ] Handle `{ type: "execute", plan, model }` — call `setActiveToolsByName(["read", "bash", "edit", "write"])`, switch model, run execution prompt
- [ ] Handle verification: Pi runs repo's tests/lints, retry up to 5 times on failure
- [ ] Handle `{ type: "create_pr", ... }` — create branch, commit, push, `gh pr create --base {default_branch}`
- [ ] DO: provision sandbox via `@cloudflare/sandbox` SDK, establish WebSocket to sandbox
- [ ] DO: forward CLI messages to sandbox, forward sandbox events to CLI
- [ ] DO: implement event redaction before persisting/forwarding (exact-match + pattern-match)
- [ ] LLM key: write to `/run/secrets/llm_key` tmpfs, entrypoint reads and unlinks

### Review checkpoint

Run a real task against a test repo. Watch Pi explore in plan mode — verify no write/edit/bash tools are available. Approve the plan. Watch execution. Verify the PR is created correctly.

---

## Phase 5: Security Layers

Layer security onto the working system. These are already specced — this phase is about implementation and testing.

### Tasks

- [ ] Git credential broker: implement credential helper in sandbox that requests PAT from DO over WebSocket
- [ ] DO credential broker: validate host matches expected repo origin before responding
- [ ] Verify PAT never appears in sandbox env vars, filesystem, or process environment
- [ ] Verify LLM key is not in shell env (`printenv`, `env` should not show it)
- [ ] Event redaction: test with a repo that has a script that runs `printenv` — verify secrets are scrubbed from event log
- [ ] Event log limits: enforce 64 KB max per event payload, 32 KB bash stdout capture
- [ ] Event log retention: prune events older than 7 days on DO wake

### Review checkpoint

Deliberately try to leak secrets through bash tool output, malicious test scripts, and env var dumps. Verify redaction catches all cases. Inspect DO SQLite to confirm no secrets are persisted.

---

## Phase 6: End-to-End Polish

Full lifecycle, cost controls, edge cases.

### Tasks

- [ ] Cost controls: track token spend across plan + execution, enforce `max_cost`
- [ ] Time controls: enforce `max_time` with state preservation on breach
- [ ] Step controls: enforce `max_steps` (tool call count)
- [ ] Timeout handling: sandbox cleanup on `timed_out` or `cost_exceeded`
- [ ] Error handling: surface unrecoverable errors cleanly to CLI
- [ ] DO hibernation: hibernate after session completion, wake on new WebSocket connection
- [ ] Sandbox cleanup: destroy sandbox on session end (completed, failed, aborted)
- [ ] Test with multiple concurrent sessions against the same repo

### Review checkpoint

Run several real tasks end-to-end. Hit cost/time limits intentionally — verify state is preserved and user gets clear feedback. Run two concurrent sessions and verify isolation.

---

## Notes

- Each phase should be reviewed and understood before starting the next
- The spec is the source of truth — if implementation diverges, update the spec or fix the code
- Pi SDK source is at `/Users/skrishnan/development/pi-mono/` for reference
