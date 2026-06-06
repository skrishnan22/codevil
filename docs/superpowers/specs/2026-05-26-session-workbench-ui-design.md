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
    ├── Left pane: current agent + conversation + chat input
    └── Right pane: Changes / Preview / Activity workspace
```

The left pane answers: what is happening, what did the agent say, and does it need the user?  
The right pane answers: what changed, what does it look like, and what exactly did the agent do?

## Goals

- Keep current agent activity visible without relying on scroll position.
- Prevent live preview from splitting the conversation stream.
- Show files touched and diffs as first-class session artifacts.
- Preserve a calm monitoring workflow for users who periodically check in.
- Keep low-level tool trace available through Activity without making it the default surface.
- Respect user scroll position during active streaming.

## Non-Goals

- No IDE-style file explorer as the primary layout.
- No three-column default view inside the right workspace.
- No forced auto-scroll for errors, approvals, or verification failures.
- No redesign of the preview backend or preview lifecycle.
- No new diff computation backend requirement; the first implementation may show an empty diff state.

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
2. **Conversation** as the only scrollable middle region.
3. **Chat input** fixed at the bottom.

The current-agent card is the canonical live focus surface. It shows:

- phase and status;
- latest running tool or thinking text;
- concise tool summary;
- attention state when input is needed, verification fails, or an error occurs;
- action buttons where appropriate, such as approve, view plan, or jump to attention.

Plan review remains in the existing slide-out for the first implementation. The current-agent card and Conversation plan attention card can both open that slide-out. Do not add a separate Plan workspace tab.

The conversation is chronological, newest at the bottom. It contains:

- user messages;
- finalized assistant replies;
- milestones;
- attention cards;
- compact trace groups;
- high-level session events.

Routine tool calls and thinking entries should be grouped into compact trace groups so the conversation does not churn during execution.

Compact activity group rows remain visible in Conversation, collapsed by default. They summarize completed batches rather than streaming every event. A row can say, for example, `12 actions · 3 files changed` and opens the corresponding detail in Activity.

### Right Pane: Artifact Workspace

The right pane is the session artifact workspace. Its header contains:

- `Changes`, `Preview`, and `Activity` tabs;
- the preview toggle;
- optional secondary controls for the active tab.

The first version should not add inactive tab badges. Updates should refresh their tabs without stealing focus, except for the explicit preview-toggle switching behavior below.

Workspace tab selection follows this rule:

- When preview is toggled on, switch the workspace to `Preview`.
- While preview remains on, the user may manually switch to `Changes` or `Activity`; keep their manual selection.
- When preview is toggled off, default the workspace to `Changes`.
- While preview remains off, the user may manually switch to `Activity`; keep their manual selection until they switch tabs or toggle preview on again.

## Left Pane Scroll Contract

The scroll behavior is part of the product design, not an implementation detail.

### Follow State

The conversation has two follow states:

- **Following latest:** user is at or near the bottom; new content auto-scrolls.
- **Reading history:** user has scrolled away; new content does not move the viewport.

When the user is reading history, show a small sticky control near the bottom of the conversation:

```text
N new updates · Jump to latest
```

Clicking it scrolls to the bottom and resumes following latest.

### Streaming Messages

Streaming assistant output should update the current-agent card and Activity. It should not append visible conversation messages for each partial update.

When Pi reaches `agent_end`, Codevil may promote the finalized assistant text for that prompt into Conversation as an assistant reply. Do not duplicate it if the same output has already been promoted into a more specific Codevil event such as `plan_ready`, `verification_failed`, or `complete`.

Intermediate assistant turns whose purpose is tool use should not appear as standalone Conversation entries. They remain visible in the current-agent card while live and in Activity for inspection.

Finalized assistant replies render as normal assistant chat bubbles unless they map to a known session state:

- clarification or user decision needed: attention card;
- plan ready: plan approval card;
- verification failed: attention card;
- session complete or PR created: completion milestone/card;
- ordinary explanatory reply: assistant bubble.

Streaming tool activity should update:

- the fixed current-agent card;
- the current compact trace group in Activity;
- the Activity tab, if open.

It should not create repeated standalone conversation entries while the agent is working.

When a turn or meaningful batch completes, Conversation can append or update one collapsed activity group row summarizing the batch. This row is not a chat message; it is a navigational summary into Activity.

### Attention Events

Approval needed, verification failed, and error states must surface immediately in the fixed current-agent card. They should also appear as attention cards in the conversation.

These events do not force-scroll the conversation. If the user is reading history, the current-agent card carries the urgency and offers a jump action.

If the user is already following latest, the conversation may naturally remain at the new attention card because normal follow behavior applies.

### Current Agent Card Role

The current-agent card exists because the conversation cannot always communicate current focus cleanly during streaming. It should not duplicate the entire latest conversation item. It should summarize the active state and provide immediate action.

Examples:

- Running: `Editing packages/web/src/routes/session.$id.tsx`
- Thinking: latest concise thinking summary.
- Waiting: `Plan ready for review` with approve/refine actions.
- Failed: `Verification failed` with last error and jump/view actions.

When there is no active tool or assistant stream, the card should persist the last meaningful state rather than collapsing to an empty idle panel. For example, after `agent_end` it can keep the finalized assistant reply, phase transition, or latest attention/completion state until a new active state replaces it.

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

For the first implementation, real diff data is not required. The Changes tab should show files touched from existing tool-argument inference and an empty diff state such as `No patch available yet`. Do not parse arbitrary tool output to synthesize diffs.

## Preview Tab

The `Preview` tab displays the existing live preview iframe and preview status controls.

Preview precedence is explicit:

- toggled off: preview is available but not the default workspace;
- toggled on: preview becomes the active workspace;
- preview error: show the error inside the Preview tab and reflect the issue in the current-agent card only if it blocks the session.

The preview iframe should use the right pane width and height, not a vertical slice between status and conversation.

## Activity Tab

The `Activity` tab contains detailed tool inspection.

It replaces the need for a constantly visible inspector pane. It can include:

- grouped turns or trace groups;
- selected tool detail;
- tool input;
- tool output;
- read output or command output;
- low-level errors.

Activity is for investigation, not routine monitoring. Conversation links or compact trace group expansions can open the relevant item in the Activity tab.

## Data Model

The UI can derive most of the new surfaces from existing session state:

- `messages` feed conversation messages, milestones, attention cards, and streaming assistant content.
- `activityLog` feeds current-agent state, trace groups, files touched, and trace detail.
- `preview` feeds workspace default selection and preview status.
- `planApproved` and `sessionPhase` feed approval and phase state.

Pi event promotion rules:

- `message_update` updates current-agent card and Activity only.
- `turn_end` may update Activity and the current assistant reply candidate.
- `agent_end` may promote the final assistant reply candidate into Conversation.
- `plan_ready`, `verification_failed`, `error`, and `complete` take precedence over generic assistant reply promotion.

Files touched should initially be derived from tool call arguments using the existing path extraction approach, then expanded when backend diff metadata exists.

Suggested derived structures:

```ts
interface WorkspaceState {
  activeTab: "changes" | "preview" | "activity";
  previewPinned: boolean;
  selectedFilePath: string | null;
  selectedActivityId: string | null;
}

interface FileTouch {
  path: string;
  mode: "read" | "write" | "modified";
  additions?: number;
  deletions?: number;
  activityIds: string[];
}

interface ConversationFollowState {
  mode: "following-latest" | "reading-history";
  unseenCount: number;
}
```

## Responsive Behavior

Mobile is not a priority for the first implementation. The UI should remain usable and not visibly broken, but the desktop workbench is the primary target.

Desktop and wide tablet:

- two-pane workbench;
- left narrative column fixed between roughly 380px and 460px;
- right workspace takes remaining width.

Narrow screens:

- use a single-pane layout with top-level `Conversation` and `Workspace` tabs;
- current-agent card remains fixed above the active pane;
- chat input remains fixed at the bottom when Conversation is active.

## Testing

Add focused tests around derived behavior:

- preview on selects the Preview workspace;
- preview off defaults to Changes;
- user-selected Activity remains stable unless preview is toggled on;
- conversation does not follow when user is reading history;
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
4. Move detailed tool inspection behind an `ActivityTab`.
5. Refine conversation follow state and unseen update behavior.
6. Update current-agent card behavior for attention states.

Existing components can be adapted:

- `StatusStrip` becomes or feeds the fixed current-agent card.
- `Timeline` can remain the internal component if that keeps the implementation smaller; user-facing labels should say Conversation.
- `LivePreview` moves into the Preview tab.
- `DetailPanel`, `TraceGroup`, and inspector pieces move behind Activity.
- file collection logic from `left-pane.tsx` feeds the Changes tab.
