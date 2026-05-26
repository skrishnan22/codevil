# Session Workbench UI Revamp

**Date:** 2026-05-26  
**Status:** Draft for user review

## Overview

Revamp the Codevil session UI into a two-pane workbench that separates session narrative from session artifacts.

The current vertical structure puts current-agent status, chat/events, and live preview in one stack. Once live preview is enabled, it cuts across the conversation and makes it harder to see what the agent is doing. The UI also lacks a strong place for files touched, selected diffs, and detailed trace inspection.

The new structure is:

```text
Top bar
└── Session workbench
    ├── Left pane: current agent + chronological timeline + chat input
    └── Right pane: Changes / Preview / Trace workspace
```

The left pane answers: what is happening, what did the agent say, and does it need the user?  
The right pane answers: what changed, what does it look like, and what exactly did the agent do?

## Goals

- Keep current agent activity visible without relying on scroll position.
- Prevent live preview from splitting the conversation stream.
- Show files touched and diffs as first-class session artifacts.
- Preserve a calm monitoring workflow for users who periodically check in.
- Keep low-level tool trace available without making it the default surface.
- Respect user scroll position during active streaming.

## Non-Goals

- No IDE-style file explorer as the primary layout.
- No three-column default view inside the right workspace.
- No forced auto-scroll for errors, approvals, or verification failures.
- No redesign of the preview backend or preview lifecycle.
- No new diff computation backend requirement beyond displaying available diff data.

## Layout

### Top Bar

The top bar remains global session chrome:

- product/session identity;
- connection and session phase;
- repo/model/cost/tokens/elapsed metadata;
- stop control.

It should not carry detailed activity, files, or preview controls.

### Left Pane: Narrative

The left pane is a fixed-width narrative column. It contains:

1. **Current Agent card** fixed at the top of the pane.
2. **Timeline** as the only scrollable middle region.
3. **Chat input** fixed at the bottom.

The current-agent card is the canonical live focus surface. It shows:

- phase and status;
- latest running tool or thinking text;
- concise tool summary;
- attention state when input is needed, verification fails, or an error occurs;
- action buttons where appropriate, such as approve, view plan, or jump to attention.

The timeline is chronological, newest at the bottom. It contains:

- user messages;
- assistant messages;
- milestones;
- attention cards;
- compact trace groups;
- high-level session events.

Routine tool calls and thinking entries should be grouped into compact trace groups so the timeline does not churn during execution.

### Right Pane: Artifact Workspace

The right pane is the session artifact workspace. Its header contains:

- `Changes`, `Preview`, and `Trace` tabs;
- the preview toggle;
- optional secondary controls for the active tab.

Workspace tab selection follows this rule:

- If preview is toggled on, `Preview` is active and owns the workspace.
- If preview is toggled off, `Changes` is active by default.
- The user may manually inspect another tab, but toggling preview on should return the workspace to `Preview`.

## Left Pane Scroll Contract

The scroll behavior is part of the product design, not an implementation detail.

### Follow State

The timeline has two follow states:

- **Following latest:** user is at or near the bottom; new content auto-scrolls.
- **Reading history:** user has scrolled away; new content does not move the viewport.

When the user is reading history, show a small sticky control near the bottom of the timeline:

```text
N new updates · Jump to latest
```

Clicking it scrolls to the bottom and resumes following latest.

### Streaming Messages

Streaming assistant output should update the current assistant message in place. It should not append a new visible message for each partial update.

Streaming tool activity should update:

- the fixed current-agent card;
- the current compact trace group in the timeline;
- the Trace tab, if open.

It should not create repeated standalone timeline entries while the agent is working.

### Attention Events

Approval needed, verification failed, and error states must surface immediately in the fixed current-agent card. They should also appear as attention cards in the timeline.

These events do not force-scroll the timeline. If the user is reading history, the current-agent card carries the urgency and offers a jump action.

If the user is already following latest, the timeline may naturally remain at the new attention card because normal follow behavior applies.

### Current Agent Card Role

The current-agent card exists because the timeline cannot always communicate current focus cleanly during streaming. It should not duplicate the entire latest timeline item. It should summarize the active state and provide immediate action.

Examples:

- Running: `Editing packages/web/src/routes/session.$id.tsx`
- Thinking: latest concise thinking summary.
- Waiting: `Plan ready for review` with approve/refine actions.
- Failed: `Verification failed` with last error and jump/view actions.

## Changes Tab

The `Changes` tab is the default artifact view when preview is off.

Its layout is:

```text
Changes header
Files touched strip
Full-width diff viewer
```

The files touched strip is horizontal and sits above the diff. It contains compact file chips with:

- file path or shortened path;
- read/write/modified status;
- additions/deletions when available;
- selected state.

The diff viewer receives the full workspace width below the strip. It must not be squeezed by a persistent file sidebar. For many files, the strip can scroll horizontally or open a picker, but the default view preserves diff width.

When no diff is available yet, the Changes tab should still show files touched from tool activity and an empty diff state such as `No patch available yet`.

## Preview Tab

The `Preview` tab displays the existing live preview iframe and preview status controls.

Preview precedence is explicit:

- toggled off: preview is available but not the default workspace;
- toggled on: preview becomes the active workspace;
- preview error: show the error inside the Preview tab and reflect the issue in the current-agent card only if it blocks the session.

The preview iframe should use the right pane width and height, not a vertical slice between status and timeline.

## Trace Tab

The `Trace` tab contains detailed tool inspection.

It replaces the need for a constantly visible inspector pane. It can include:

- grouped turns or trace groups;
- selected tool detail;
- tool input;
- tool output;
- read output or command output;
- low-level errors.

Trace is for investigation, not routine monitoring. The left timeline links or trace group expansions can open the relevant item in the Trace tab.

## Data Model

The UI can derive most of the new surfaces from existing session state:

- `messages` feed timeline messages, milestones, attention cards, and streaming assistant content.
- `activityLog` feeds current-agent state, trace groups, files touched, and trace detail.
- `preview` feeds workspace default selection and preview status.
- `planApproved` and `sessionPhase` feed approval and phase state.

Files touched should initially be derived from tool call arguments using the existing path extraction approach, then expanded when backend diff metadata exists.

Suggested derived structures:

```ts
interface WorkspaceState {
  activeTab: "changes" | "preview" | "trace";
  previewPinned: boolean;
  selectedFilePath: string | null;
  selectedTraceId: string | null;
}

interface FileTouch {
  path: string;
  mode: "read" | "write" | "modified";
  additions?: number;
  deletions?: number;
  activityIds: string[];
}

interface TimelineFollowState {
  mode: "following-latest" | "reading-history";
  unseenCount: number;
}
```

## Responsive Behavior

Desktop and wide tablet:

- two-pane workbench;
- left narrative column fixed between roughly 380px and 460px;
- right workspace takes remaining width.

Narrow screens:

- use a single-pane layout with top-level `Timeline` and `Workspace` tabs;
- current-agent card remains fixed above the active pane;
- chat input remains fixed at the bottom when Timeline is active.

## Testing

Add focused tests around derived behavior:

- preview on selects the Preview workspace;
- preview off defaults to Changes;
- user-selected Trace remains stable unless preview is toggled on;
- timeline does not follow when user is reading history;
- unseen update count increments while reading history;
- attention events do not force-scroll;
- jump to latest resumes following;
- streaming messages update in place.

Add component-level coverage where practical for:

- files touched strip selection;
- empty diff state;
- current-agent attention rendering.

## Implementation Notes

The first implementation should avoid a broad rewrite. A practical sequence is:

1. Introduce a `SessionWorkbench` layout in `packages/web/src/routes/session.$id.tsx`.
2. Move preview into a right-pane `WorkspacePane`.
3. Add `ChangesTab` with file strip, full-width diff viewer, and an explicit empty diff state.
4. Move detailed tool inspection behind a `TraceTab`.
5. Refine timeline follow state and unseen update behavior.
6. Update current-agent card behavior for attention states.

Existing components can be adapted:

- `StatusStrip` becomes or feeds the fixed current-agent card.
- `Timeline` remains the chronological scroll surface.
- `LivePreview` moves into the Preview tab.
- `DetailPanel`, `TraceGroup`, and inspector pieces move behind Trace.
- file collection logic from `left-pane.tsx` feeds the Changes tab.
