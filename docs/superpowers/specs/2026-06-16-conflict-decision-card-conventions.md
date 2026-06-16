# Engineering conventions for the conflict-card implementation

> Companion to [2026-06-16-conflict-decision-card-in-conversation.md](2026-06-16-conflict-decision-card-in-conversation.md). Captures the standards we hold this change to. Scoped to the stack actually involved — `@codevil/shared`, `@codevil/worker`, `@codevil/web`. Not an architecture overhaul; matches what the codebase already does, and locks it in for the new code.

## Stack at a glance

- **Runtime:** Node 20+, ESM only (`"type": "module"`). pnpm workspaces.
- **TypeScript:** strict mode on (`tsconfig.base.json`), `verbatimModuleSyntax: true`. Type-only imports must use `import type`. No `tsc --noEmit` warnings allowed.
- **Web:** React 19, Zustand 5, TanStack Router. Build: `vite`. Tests: `vitest` in **`node`** environment (no jsdom).
- **Shared contracts:** zod schemas in `@codevil/shared`, infer-from-schema types via `z.infer<>`.
- **Worker (DO):** Cloudflare Worker + Durable Object. Uses `this.sql.exec(...)` for persistence; events are emitted via `appendAndBroadcast`.
- **No linter / formatter config in the repo.** Convention is consistency with surrounding code: 2-space indent, double quotes, semicolons, trailing commas. We do not introduce ESLint/Prettier in this change.

## Validation & types

- **Wire contracts are zod schemas** in `packages/shared/src/messages-cli.ts`. The TypeScript type is always derived (`z.infer`) — never hand-written. If you add a field, add it to the schema first; the type follows.
- **Discriminated unions over flags.** New event variants extend `DOToCLIEventSchema` via the existing `z.discriminatedUnion("type", [...])`. Render-side dispatch is `switch (event.type)`, exhaustively (one case per variant, default returns `[]` or throws).
- **`PersistedDOToCLIEventSchema` is `{type: string}.passthrough()`** — by design, persisted history is not re-validated on replay. **Back-compat for new optional fields lives in the consumer (reducer / selector), not the schema.** Pattern: `const raisedAt = event.raised_at ?? <fallback>`.
- **No `as` casts in store/component code.** If you reach for `as`, redesign the surrounding types. The one allowed escape hatch is at the WS boundary, and that already runs through the strict zod parse.
- **Make illegal states unrepresentable.** Examples for this change:
  - The conflict-card visual state is a discriminated `type CardState = { kind: "pending" } | { kind: "selected"; sideId: string } | { kind: "submitting"; sideId: string } | { kind: "resolved"; …}` — never a `{ selected?: string; submitting?: boolean; resolved?: boolean }` bag.
  - The Timeline-item conflict variant only resolves to a *render*-time conflict card when the conflict-shape predicate passes. The predicate is the only place that promotes a generic `QuestionViewModel` to "this is a conflict."

## Module shape & seams

- **One responsibility per file.** Our targets in this change:
  - `ConflictDecisionCard.tsx` — presentational; no event handling beyond store-action dispatch.
  - `conflict-question.ts` — predicate + pure helpers (shape check, side derivation from annotations, queue ordering). No React, no store imports.
  - `chat-input-gate.ts` — single pure function `shouldDisableChatInput(questions)`.
  - `question-card.tsx` — router that picks Conflict vs generic. Stays small.
- **DI via small props/seams, not module-level singletons.** Components consume `useSessionStore` selectors directly — this is the project's existing pattern, do not invent a new injection layer. The pure helpers we *can* test (predicate, side-derivation, gate) live in plain `.ts` files so tests don't need the store.
- **Public surface from each file is deliberate and minimal.** Default to `export function ...` for the one thing the file is for; everything else is module-local. Re-export only what a sibling actually consumes.

## Errors / edge cases

- **No `throw` from React render code.** Guard with predicates and render fallback UI.
- **Reducers are total.** `reduceQuestions` already handles unknown event types by returning `current` — preserve that. New code paths in the reducer must also be total.
- **Annotation lookups can fail.** When the card resolves an `option.id` (thread id) to an annotation and the annotation is gone (withdrawn, garbage-collected after a round), the card renders the option's own `label`/`detail` from the question payload and labels the side `· annotation withdrawn`. We never throw or render `undefined`.
- **`canAnswer === false`** never disables the card *visually beyond what's specified*; it disables the commit action and shows the waiting hint. Read-only display still works.

## Logging / telemetry

- The web layer does not log to console in production paths. `console.warn` is acceptable for "this should never happen but if it does, here's what we noticed" branches.
- The worker uses `console.log` already (`orchestrator.ts`) — match that. Don't add structured logging just for this change.

## Tests

- **Framework:** vitest. Tests live in `__tests__/` directories next to the code under test (existing pattern in the repo).
- **Web tests run in `environment: "node"`.** No DOM, no React rendering — there is no testing-library installed. **Component "tests" in this repo are pure-function tests** against the testable logic extracted from the component. We follow that pattern:
  - The conflict-shape predicate is unit-tested directly.
  - The chat-input gate selector is unit-tested directly.
  - The Timeline conflict-item derivation (the change to `deriveTimeline`) is unit-tested directly — `deriveTimeline` is already a pure exported function (see `live-preview.test.tsx` for the precedent of testing extracted pure functions).
  - We do **not** render `ConflictDecisionCard` in a test. We assert its behavior by testing the data it consumes (predicate, side derivation, queue order) and the state machine helper (next-state on click / commit / arrive-of-answered). The component is then a thin shell over those tested units.
- **Tests assert real behavior, not implementation details.** Identity-stable returns (e.g. `expect(second).toBe(first)`) are valid when they encode a contract (no-op reducer must not allocate); structural assertions (`expect(result).toEqual([...])`) elsewhere.
- **Reducer tests:** add cases for `question_raised` with and without `raised_at`. The "without" case must produce a `raisedAt` value that is monotonically usable (Date.now-at-reduce fallback).
- **Schema tests** (`packages/shared/test/messages-cli.test.mjs`) update: existing two `QuestionRaisedEventSchema.parse` cases gain `raised_at`. Add one new case asserting that strict parsing rejects a `question_raised` event missing `raised_at`.

## Style points (small, but worth pinning)

- `import type { … }` for type-only imports — required by `verbatimModuleSyntax: true`.
- Prefer named exports. Default exports only where a framework requires it (none in our scope).
- React: function components, hooks; no class components, no `forwardRef` unless a child consumer needs it.
- Use existing CSS tokens from `session-theme.css` (`--accent`, `--surface`, `--warn`, `--r-md`, …). Do **not** introduce new color tokens for this change. Card styles go into `session-components.css` next to the existing `.question-*` rules.
- No `useEffect` for state that is derivable. The conflict pager, the "head-of-queue", and the chat-input disable state are all selectors, not effects.

## What we will run before claiming "done"

From `packages/web` and `packages/shared`:

```
pnpm typecheck       # in packages/web
pnpm test            # in packages/web (vitest run)
node --test packages/shared/test/messages-cli.test.mjs   # if shared schema changed
pnpm build           # in packages/web (tsc + vite build); must complete with zero errors
```

For the worker:

```
pnpm --filter @codevil/worker typecheck
pnpm --filter @codevil/worker test    # if there is one; otherwise typecheck is the bar
```

End-to-end verification (real run) before merging:
- Launch the app, drive a session into plan-review, create two conflicting annotations, watch Pi raise a conflict question, see the card in the timeline, select a side, commit, observe Pi continue. Repeat with a second conflict in the same round to exercise the pager.
- Verify the resolved one-liner persists across a page refresh (the `raised_at` change is on the critical path here).

These are owner-verified, not subagent-verified.
