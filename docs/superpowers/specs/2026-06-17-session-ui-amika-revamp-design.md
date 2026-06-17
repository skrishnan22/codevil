# Session UI Revamp — Editorial Two-Pane Workbench

**Date:** 2026-06-17
**Status:** Draft for user review
**Inspiration:** amika.dev — editorial typography, warm restraint, premium polish, playful character

## Overview

Take the existing session workbench (left narrative / right artifact) from "functional but plain" to a world-class editorial product. The structure stays — two balanced 50/50 panes — but every surface inside gets rebuilt against a coherent design system. No new IA, no new features, no new tabs. Just dramatically less chrome, a stronger type voice, and character on the surfaces users touch most: the question card, the composer, and the activity timeline.

The existing layout commits ~330px of vertical space to chrome (~192px stacked top headers, ~140px composer) before the conversation breathes. This spec cuts that to roughly 100px top + 56px composer through ruthless header consolidation and a slim single-line pill composer.

## Goals

- Establish a coherent design system (palette, typography, spacing, motion) — apply it to every surface in this session view.
- Collapse three stacked top bars into one 36px utility rail + an inline editorial header that scrolls with content.
- Replace the multi-row composer with a single-line pill that preserves one-click access to `@codevil` direction and `Plan first` mode.
- Give the in-stream `ask_question` card character — treat it as Codevil's next message, not a form.
- Reduce activity-timeline noise by grouping each agent turn (thinking + tool + result) into one readable block. Kill the repeated `THINKING` labels.
- Move connection status off its own row — embed it as a status dot.

## Non-Goals

- No changes to data flow, store shape, websocket protocol, or routing.
- No changes to the conflict-decision routing logic — `ConflictDecisionCard` keeps its own router entry in `question-card.tsx`, but its visual treatment converges with the generic `ask_question` card.
- No new tabs in the right pane (Activity / Preview stay).
- No changes to which information is shown — every metric, button, and pill from the current UI is preserved somewhere; this is a hierarchy and typography exercise.
- No mobile-specific work. Desktop session view only.
- No motion system beyond subtle hover/selection transitions and a single pulsing "running" marker.

## Design System

### Palette — Cool linen + sage

| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#F8F8F5` | App background (panes) |
| `--bg-surface` | `#FFFFFF` | Cards, composer pill, message bubbles |
| `--bg-elevated` | `#FCFCFA` | Result snippets, hover states |
| `--ink` | `#0F1419` | Primary text |
| `--ink-2` | `#1A1F26` | Body text (slightly softer for long-form) |
| `--ink-3` | `#4A5159` | Secondary text |
| `--ink-mute` | `#687A6E` | Meta, timestamps, kickers (warm gray) |
| `--edge` | `#E3E6E1` | Borders |
| `--edge-soft` | `#ECECE5` | Dividers, subtle separators |
| `--sage` | `#4F7860` | Active/selected accent, "running" state |
| `--sage-soft` | `#F0F4F1` | Selected option background, attention chip |
| `--moss` | `#687A6E` | Kicker text on sage backgrounds |
| `--amber` | `#FEF3C7` / `#92400E` | Plan-first chip, tool-call chip (bg / fg) |
| `--danger` | `#B91C1C` / `#FEF2F2` | Failed state pill, Stop button |

The unused `--app-bg: #F5F2EB` and other paper/desk variables in the current CSS are deleted.

### Typography

Add a serif body face alongside the existing Outfit (or Inter) sans:

- **Sans (body, UI):** Inter (or keep Outfit if license/perf wins). Used for messages, options, meta, controls.
- **Serif (headlines + thinking):** Tiempos Text — used for the editorial room title (h1), the question card question, and the agent's thinking transcript (italic).

Scale (12 / 13 / 14 / 18 / 22–24 / 32 reserved for empty states):

| Use | Family | Size / weight / tracking |
|---|---|---|
| Room title (h1) | serif | 24px / 500 / -0.018em |
| Question card question | serif | 18–22px / 500 / -0.015em |
| Activity thinking (italic) | serif | 13px / italic |
| Body message text | sans | 14px / 400 |
| Option title | sans | 13–14px / 600 |
| Option description | sans | 12px / 400 |
| Meta (timestamps, ids) | sans / mono | 11px / 500 |
| Kicker (ROOM · EXECUTE) | sans | 10px / 600 / 0.16em uppercase |
| Stat numbers | mono / sans tabular | 11–12px / 600 |

### Spacing & Radii

- Card padding: 16–22px.
- Pill radius: `999px` for composer, chips; `8–14px` for cards.
- Gutters between panes: a single 1px `--edge-soft` divider, no shadow.
- Composer pill shadow: `0 1px 2px rgba(15,20,25,0.04), 0 4px 12px rgba(15,20,25,0.04)`.
- No drop shadows on cards inside the panes — borders only.

---

## Header Consolidation

Today: `top-bar.tsx` (~56px) + `session-top-bar.tsx` (~56px) + `room-header.tsx` (~80px) = ~192px.
Target: 36px pinned utility rail + ~96px inline editorial header that scrolls with content = ~132px present at top, only 36px pinned.

### Utility Rail (pinned, 36px)

A single horizontal rail. Left-to-right:

`[logo] Codevil / ses_3b94f0… ⟨spacer⟩ $0.00 · 0 tok · 1159m [Failed] [■ Stop] · Sessions · Settings [profile-avatar]`

Notes:
- Session ID is truncated; full ID on hover.
- The Failed/Running/Completed pill replaces the standalone status strip — it sits inline on the rail.
- Stop button is danger-tinted but ghost-styled (white bg, red ink).
- Sessions / Settings nav lives here, replacing the current right-side links on the top bar.
- Connection status moves to a small dot on the profile avatar (green / amber / red). The verbose "CONNECTED" footer under the composer is removed.

This merges `top-bar.tsx` and `session-top-bar.tsx` into one component (`session-rail.tsx`). Both old components are deleted.

### Inline Editorial Header (scrolls with content)

Sits at the top of the left pane, above the first message. Replaces `room-header.tsx` visually, same logic:

```text
ROOM · EXECUTE           (kicker — 10px uppercase, moss)
do you have access to    (serif h1 — 24px, ink, -0.018em)
brainstorm skill?
██▌··· 2/5 · Execute   K K C   3 in room    (meta row, 11px)
```

- Scrolls away with the conversation rather than staying pinned — accepted tradeoff for editorial weight and breathing room. Hovering the session ID in the rail shows the full ID in a tooltip; the room title itself is intentionally not duplicated in the rail.
- The 5-bar phase progress moves inline into this meta row.
- Avatar stack uses `assignParticipantAvatarColors` exactly as today; only sizes/border-color change.

`room-header.tsx` is updated, not deleted — same props, same store reads, new markup + tokens.

---

## Conversation Pane (left)

### Message Bubble

`message-bubble.tsx` updated to match the new system:

- 30px circular avatar (vs. 32px today). Avatar background = participant color. Codevil avatar = `--ink`.
- Name row: bold name (13px) + small `12:06 AM` time (11px, `--ink-mute`).
- Body: 14px sans, `--ink-2`, line-height 1.55.
- `@codevil` mentions render as a small amber chip (`--amber` bg/fg), `font-weight: 500`.
- No bubble background by default — messages flow on the app bg with avatar-only structure.

### In-Stream Ask Card

`question-card.tsx` — replace the `<article class="question-card">` markup with a "message + ask pill" treatment. Both the generic `ask_question` path AND `ConflictDecisionCard` adopt this shape (the conflict card keeps its own router selection and answer logic; it just inherits the visual envelope).

Structure:

```
[Codevil avatar]  Codevil  [✦ asks]  12:07 AM · anyone in room

                  Serif question (18px, 500)
                  Optional context (13px, ink-3)

                  ┌────────────────────────────────────────┐
                  │ [ ] Option title                        │ ← bordered option row
                  │     Option description (12px, ink-3)    │
                  └────────────────────────────────────────┘
                  ┌────────────────────────────────────────┐
                  │ [✓] Selected option                     │ ← sage border, sage-soft bg
                  │     Description                          │
                  └────────────────────────────────────────┘

                  [Submit answer]  Or type your own answer ↓
```

- `ask-pill`: small sage chip with `✦` glyph, next to Codevil's name.
- Options are rounded rectangles with 1.5px border. Selected = `--sage` border, `--sage-soft` bg, sage-filled checkbox.
- Submit button is sage-filled (`--sage`), not ink-black, so the answerable surface is visually distinct from passive ink controls.
- Multi-select uses the same option rows; the existing `allowMultiple` and `toggleOption` logic is unchanged.
- The freeform textarea (`question.allowFreeform`) reveals inline below the options when "Or type your own answer ↓" is clicked, or stays revealed if there are no options.
- The "assigned to" select and "waiting hint" stay — both render as small meta lines under the question, styled as 11px `--ink-mute`.

`question-card.tsx` keeps its existing routing (conflict vs. generic vs. answered) and props. Only the markup + CSS class names change.

### Composer

`ChatInput.tsx` → single-line pill. Replaces the current avatar + textarea + 3 tools + footer.

```
┌──────────────────────────────────────────────────────────────────┐
│ [@codevil] [✦ Plan]  ___ type your message _________________  [↑]│
└──────────────────────────────────────────────────────────────────┘
   ↵ send · ⇧↵ newline · / commands                       (caption)
```

- The pill grows downward (multi-line) when the user types beyond one row; collapses on send.
- `@codevil` chip = direction toggle. On = the message is addressed to the agent (today's `@codevil` mention is inserted on send). Off = the message goes to the room only. Click flips it; default state is **off** for new sessions, sticky to last setting for the current user within the session.
- `✦ Plan` chip = plan-first toggle. Amber when active. Disabled (50% opacity) when `@codevil` is off. Same semantics as today's `setPlanFirst` checkbox.
- Send button: 32px black circular pill with `↑`. Disabled state: light gray bg.
- Keyboard hint caption only appears on focus; hides otherwise.
- Connection status moves to a dot on the profile avatar in the rail (bottom-right, sage = connected, amber = reconnecting, red = disconnected, hidden when connected if visual quiet is preferred). The current `chat-connection-status` row under the composer is deleted.
- Conflict gate (`shouldDisableChatInput`) keeps its behavior: when active, the input placeholder swaps to "Resolve the decision above to continue." and both chips + send are dimmed.

Slash commands (`/plan`, `/skill`, etc.) are noted as a future enhancement — out of scope for this spec, but the pill is shaped to accept them.

---

## Activity Pane (right)

`activity-tab.tsx` + `Timeline.tsx` + `TimelineItem.tsx` + `TraceGroup.tsx` adopt a "grouped agent turn" treatment. Each turn block visually combines its thinking, tool call, and result.

### Pane Header

`inspector-header.tsx` is updated:

- Tabs (`Activity` / `Preview`) become small text pills on the left; active = filled `--ink` background, inactive = transparent with `--ink-mute` text.
- The "Needs attention" indicator becomes a small sage chip (`--sage-soft` / `--sage`) with a leading dot.

### Turn Block

```
●  Ran the build to verify the landing app compiles            t59–60 · 62s
│
│   "Now let me do a final check. Let me run the build one
│   more time to make sure everything is clean."                  ← serif italic
│
│   [ run · cd /workspace/repo/apps/landing && npx next build ]   ← amber chip
│
│   ✓ Compiled successfully in 8.2s · 24/24 pages generated       ← mono result
```

Elements:

- 22px circular marker on the left. States:
  - `complete` — sage-filled with checkmark.
  - `running` — sage-bordered with pulsing inner dot (1.6s pulse).
  - `failed` — danger-filled with `×`.
  - `pending` — gray-bordered, empty.
- Headline (13px, sans, 500) — a human summary of what the turn was about. Uses the existing first-line / `t-number` data; replaces the current `RUN command` / `THINKING` labels.
- Meta on the right: `t59–60 · 62s` style range and elapsed.
- Thinking transcript: indented under the marker, left-bordered with `--edge-soft`, serif italic. No `THINKING` label.
- Tool call: amber chip, monospace. Tool name in bold, arg snippet in dimmer amber.
- Result snippet: monospace, `--ink-mute`, in `--bg-elevated` with a 1px border. Truncated to ~2 lines; click to expand.

A turn is defined as: an assistant chunk + zero or more tool calls + zero or more tool results, grouped by `t-number` proximity. The existing `TraceGroup` component is the natural home for this — its child rendering changes to emit one turn block instead of multiple stacked rows.

### Empty / pending / errored states

- Empty: `"Codevil hasn't started yet"` in serif italic, centered, 32px size.
- Pending: a single running marker with `"Thinking…"` and a soft skeleton bar — no fake content.
- Errored: failed marker, headline in danger-tinted ink, error result snippet.

---

## File-Level Impact

| File | Change |
|---|---|
| `packages/web/src/components/layout/top-bar.tsx` | Audit consumers; if only used by the session route, delete. If used by sessions index / settings, replace its usage on the session route only and leave the file intact. |
| `packages/web/src/components/session/session-top-bar.tsx` | Delete — entirely folded into new `session-rail.tsx`. |
| `packages/web/src/components/session/session-rail.tsx` | **New.** 36px utility rail. |
| `packages/web/src/components/session/room-header.tsx` | Update — inline editorial markup + new tokens. |
| `packages/web/src/components/chat/message-bubble.tsx` | Update — new avatar size, name row, mention chip styling. |
| `packages/web/src/components/session/question-card.tsx` | Update — converge to "message + ask pill" markup; keep routing logic. |
| `packages/web/src/components/session/conflict-decision-card.tsx` | Update — adopt shared ask-card visual envelope; keep decision-specific controls. |
| `packages/web/src/components/session/ChatInput.tsx` | Update — pill markup, chip toggles, no footer. |
| `packages/web/src/components/chat/prompt-input.tsx` | Audit — likely unused or consolidate into `ChatInput.tsx`. |
| `packages/web/src/components/session/activity-tab.tsx` | Update — adopt grouped-turn layout. |
| `packages/web/src/components/session/Timeline.tsx` | Update — render turn blocks instead of per-row rows. |
| `packages/web/src/components/session/TimelineItem.tsx` | Likely absorbed into the `TraceGroup` turn renderer. Final call (rewrite vs. delete) made during implementation. |
| `packages/web/src/components/session/TraceGroup.tsx` | Update — becomes the turn block primitive. |
| `packages/web/src/components/session/inspector-header.tsx` | Update — new tab styling, sage attention chip. |
| `packages/web/src/main.css` + `session-theme.css` + `session-components.css` | Token refresh: new variables, delete unused paper/desk vars, update all references. Add `@font-face` for Tiempos Text (or chosen serif). |

No store, no router, no protocol changes.

## Open Decisions for Implementation

1. **Serif typeface.** Tiempos Text is the visual reference; final pick may be a free alternative (Newsreader, Source Serif 4, Crimson Pro) for licensing simplicity. Decide during implementation kickoff.
2. **Sans typeface.** Keep Outfit (current) or switch to Inter. Inter is the safer system pick; Outfit has more character. Recommendation: keep Outfit for continuity, since palette + serif partner already deliver editorial weight.
3. **`@codevil` chip default state.** Off vs. on at session start. Recommendation: **off** — explicit opt-in to address the agent. Reduces accidental agent triggers in multiplayer sessions.

## Out of Scope (Future)

- Slash commands inside the composer (`/plan`, `/skill`, `/file`).
- Mobile / narrow-viewport variant.
- A live "Preview" tab redesign — same shell, same content, gets the rail/tabs polish only.
- A dark mode pass.
- Onboarding empty state for first-time sessions.
- Animated marker transitions beyond the running pulse.
