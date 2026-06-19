# Codevil — Understanding Checklist

> Living document. Updated as we progress. Goal: by the end of our session, you can confidently explain every item below without referring to docs.

---

## Stage 0: Orientation (Why this codebase exists)

- [ ] The problem Codevil is solving
- [ ] Who the user is
- [ ] The product shape: CLI vs Web vs "the thing underneath"
- [ ] Why Cloudflare was chosen as the platform
- [ ] Why Pi was chosen as the coding agent engine
- [ ] The two product layers (backend infrastructure vs web product) and how they relate
- [ ] **CORRECTION:** Plan → Approve → Execute was the old CLI flow. The current product: Session stays `ready`, an Agent Run is queued, plan is opt-in via `plan_first` flag

## Stage 1: The Big Picture Architecture

- [ ] The three (or four) moving parts: CLI → Worker → Durable Object → Sandbox
- [ ] Why each layer exists (separation of concerns)
- [ ] Why the Worker is "thin" (no business logic)
- [ ] Why one Durable Object per session
- [ ] Why the Sandbox is ephemeral
- [ ] WebSocket vs HTTP and where each is used

## Stage 2: The Session Lifecycle (Backend layer)

- [ ] What a Session is and how it maps to one `codevil run` invocation
- [ ] The 14-state state machine and which states are actually visited
- [ ] The 3 phases: Plan → Approve → Execute (and the security boundary)
- [ ] Why read-only tools during planning is a hard guarantee, not a polite suggestion
- [ ] The full happy-path lifecycle step by step

## Stage 3: The WebSocket Protocol

- [ ] Two separate message schemas: CLI↔DO vs DO↔Sandbox (why separate)
- [ ] The DO is the source of truth (all events flow through it)
- [ ] Cursor-based event replay (why this design)
- [ ] Auth: Bearer token, why session ID alone isn't enough
- [ ] At-least-once vs at-most-once delivery on each link

## Stage 4: The Domain Model (Web layer)

- [ ] Team / Auth User / Member / Membership / Role / Owner / Invite
- [ ] Session / Agent Request / Agent Run / Plan
- [ ] Activity / Conversation / Assistant Stream / Assistant Reply / Tool Trace
- [ ] How the new domain terms (CONTEXT.md) relate to the old backend (SPEC.md)
- [ ] The two ADRs and what they say about how the product has evolved

## Stage 5: Security Model

- [ ] Secret isolation: tmpfs for LLM key, credential broker for GitHub PAT
- [ ] Event redaction: exact-match + pattern-match layers
- [ ] The 5 layers of "defense in depth" from SPEC.md
- [ ] Container runs as root — what that means for blast radius
- [ ] Gaps called out in the product review (timing-safe compare, CORS, etc.)

## Stage 6: The Honest State of the Code

- [ ] Cost tracking is hardcoded to zero
- [ ] Credential broker is unimplemented
- [ ] CLI reconnect logic is broken in 3 ways
- [ ] State machine has phantom states
- [ ] What's durable vs what isn't
- [ ] Test coverage gaps
- [ ] Why "spec is the source of truth" is aspirational here

## Stage 7: Codebase Map

- [ ] packages/shared — contracts only
- [ ] packages/worker — Worker + DO + sandbox provisioning
- [ ] packages/sandbox-image — entrypoint, runtime, Pi driver, git driver
- [ ] packages/cli — thin client
- [ ] packages/web — dashboard UI
- [ ] How the imports between packages flow

## Stage 8: Deep Dives (TBD based on time/interest)

- [ ] Orchestrator state machine implementation
- [ ] appendAndBroadcast — the heartbeat
- [ ] Pi SDK integration (setActiveToolsByName, setModel, event subscription)
- [ ] Web frontend's event-mapper
- [ ] Room/multiplayer mechanics
