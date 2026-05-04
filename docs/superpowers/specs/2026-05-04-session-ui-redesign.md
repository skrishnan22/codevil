# Session UI Redesign

## Overview

Redesign the agent session view from a two-panel layout to a single-column, monitoring-first interface. The current UI shows too much information competing for attention. The new design prioritizes live activity visibility, clear "needs attention" signals, and milestone tracking.

## Target Use Case

**Primary**: Monitoring agent sessions with occasional collaboration for follow-ups or refinements.

Users kick off tasks, check back periodically, and need to quickly understand:
1. What is the agent doing right now?
2. Does it need my input?
3. What progress has been made?

## Layout Structure

Single-column layout with four zones:

```
┌─────────────────────────────────────────┐
│  TOP BAR                                │  Fixed, 50px
│  Logo, session ID, status badge,        │
│  model, cost, elapsed time              │
├─────────────────────────────────────────┤
│  STATUS STRIP                           │  Fixed, ~100px
│  Agent reasoning (full text, italic)    │
│  Current tool action + args             │
│  Phase progress indicator               │
├─────────────────────────────────────────┤
│  TIMELINE                               │  Scrollable, flex
│  Milestones (prominent cards)           │
│  Collapsed trace groups (expandable)    │
│  Agent messages                         │
│  Attention items (highlighted)          │
├─────────────────────────────────────────┤
│  CHAT INPUT                             │  Fixed, ~56px
│  Text input + send button               │
└─────────────────────────────────────────┘
```

## Components

### 1. Top Bar

Compact header with session identity and metadata.

**Contents:**
- Logo mark
- "codevil / {session_id}" with status badge (PLANNING, EXECUTING, DONE, ERROR)
- Right side: model name, cost ($X.XXXX), elapsed time

**Behavior:**
- Fixed position, always visible
- Status badge color: blue=planning, green=executing/done, red=error

### 2. Status Strip

Always-visible panel showing current agent activity with full context.

**Contents:**
- Activity indicator dot (blue=running, green=done, red=error)
- Agent reasoning text (full, not truncated, italic style)
- Current tool call: badge (READ/WRITE/BASH/etc) + file path or summary + args preview
- Footer row: phase label + step count + phase progress dots

**Behavior:**
- Fixed position below top bar
- Updates in real-time as agent works
- Clicking the tool call could expand to show full args/result (future enhancement)

**Visual treatment:**
- Background: surface-2 (slightly elevated)
- Reasoning: 12px, italic, fg-2 color
- Tool badge: colored background matching tool type (blue for read, green for write, etc.)

### 3. Timeline

Scrollable main content area with a unified view of session activity.

**Content types:**

#### Milestones
Major events that mark progress. Rendered as prominent cards.

Milestone types:
- Plan created/approved
- Tests passing
- PR created
- Session complete

**Visual:** Card with colored icon (checkmark for success), title, subtitle, timestamp, optional action link ("View plan →")

#### Collapsed Trace Groups
Routine tool calls grouped together to reduce noise.

**Visual:** Compact row showing "N tool calls · X reads, Y edits, Z thinking" with expand chevron. Clicking expands to show individual calls.

**Grouping logic:** Group consecutive tool calls until a milestone or agent message breaks the sequence.

#### Agent Messages
Text content from the agent (summaries, explanations, questions).

**Visual:** Avatar icon + bubble with message text. Similar to current chat styling.

#### Attention Items
Events requiring user action. Must be visually prominent.

Types:
- Plan approval needed
- Verification failed (needs review)
- Error requiring intervention
- Agent waiting for input

**Visual:** Card with amber/orange border and background tint, exclamation icon, clear title explaining what's needed, inline action buttons (Approve, View Diff, etc.)

**Behavior:**
- Smart scroll: auto-follow if user is at bottom, stay put if scrolled up
- Interrupt scroll: jump to attention items and milestones regardless of scroll position
- Collapsed groups remember expand state during session

### 4. Chat Input

Fixed input area for user messages.

**Contents:**
- Text input field with placeholder "Ask a question or provide feedback..."
- Send button

**Behavior:**
- Always visible at bottom
- Enter to send
- Disabled when session is complete or errored (no agent to respond)

### 5. Plan Slide-Out Panel

The implementation plan is accessed via slide-out, not inline.

**Trigger:** "View plan" link on plan milestone card

**Visual:**
- Slides in from right edge
- Width: ~50% of viewport or 600px max
- Semi-transparent backdrop over timeline
- Close button or click outside to dismiss

**Contents:**
- Plan title
- Structured plan content (objective, steps table, risk assessment, etc.)
- Rendered markdown

## Scroll Behavior

### Smart Scroll
- If user's scroll position is at or near bottom (within 100px), auto-scroll to new content
- If user has scrolled up to read earlier content, do NOT auto-scroll
- When user scrolls back to bottom, resume auto-following

### Interrupt for Important Events
Override smart scroll and jump to view when:
- Attention item appears (plan approval, error, verification failure)
- Agent is explicitly waiting for user input

Visual indicator: brief highlight animation on the newly focused item.

## Data Flow

### From existing types

`ActivityEntry` maps to timeline items:
- `kind: "tool_call"` → part of collapsed trace group OR expanded call
- `kind: "thinking"` → part of status strip reasoning + collapsed trace group
- `kind: "phase_divider"` → potential milestone marker
- `kind: "event"` → milestone or attention item depending on event type

`ChatMessage` maps to:
- `variant: "plan"` → milestone card + slide-out content
- `variant: "complete"` → milestone card
- `variant: "error"` | `variant: "verification_failed"` → attention item
- `variant: "text"` | `variant: "status"` → agent message in timeline

### New derived state needed

```typescript
interface TimelineItem {
  id: string;
  type: "milestone" | "trace-group" | "message" | "attention";
  timestamp: number;
  // Type-specific data
}

interface TraceGroup {
  id: string;
  entries: ActivityEntry[];
  expanded: boolean;
  summary: { reads: number; writes: number; thinking: number; other: number };
}

interface MilestoneItem {
  id: string;
  kind: "plan-approved" | "tests-passing" | "pr-created" | "complete";
  title: string;
  subtitle?: string;
  timestamp: number;
  action?: { label: string; handler: () => void };
}

interface AttentionItem {
  id: string;
  kind: "approval-needed" | "verification-failed" | "error" | "waiting-input";
  title: string;
  description: string;
  actions: { label: string; primary?: boolean; handler: () => void }[];
}
```

## File Changes

### Files to modify:
- `packages/web/src/routes/session.$id.tsx` - new layout structure
- `packages/web/src/components/session/` - most components replaced or heavily modified

### New components:
- `StatusStrip.tsx` - reasoning + current action display
- `Timeline.tsx` - scrollable container with smart scroll logic
- `TimelineItem.tsx` - renders milestone/trace-group/message/attention
- `TraceGroup.tsx` - collapsed/expanded trace group
- `MilestoneCard.tsx` - milestone rendering
- `AttentionCard.tsx` - attention item with actions
- `PlanSlideOut.tsx` - slide-out panel for plan view
- `ChatInput.tsx` - fixed input area (extract from ConversationPanel)

### Components to remove/deprecate:
- `LeftPane.tsx` - replaced by new layout
- `InspectorPane.tsx` - functionality merged into StatusStrip + Timeline
- `InspectorHeader.tsx` - no longer needed (filters removed)
- `TurnsList.tsx` - replaced by TraceGroup
- `DetailPanel.tsx` - functionality moves to expanded trace or slide-out
- `ConversationPanel.tsx` - replaced by Timeline + ChatInput

### Files to keep (minor updates):
- `SessionTopBar.tsx` - update styling to match new design
- `PlanCard.tsx` - adapt for use in PlanSlideOut

## CSS Changes

- Remove two-column grid from `.session-body`
- New component styles for StatusStrip, Timeline items
- Slide-out panel styles with backdrop
- Attention item highlight styles (amber theme)
- Smart scroll indicator styles

## Out of Scope

- File tree / files touched view (can be added later as collapsible section or status bar item)
- Usage/cost breakdown chart (cost shown in top bar, detailed breakdown deferred)
- Trace filtering (all/read/write/grep buttons removed - collapsed groups provide overview)
- Detail drawer for individual tool calls (deferred - expand inline or click to see in future)

## Success Criteria

1. User can see what agent is doing at a glance (status strip)
2. Attention items are immediately visible without scrolling
3. Progress milestones are clear in the timeline
4. Routine tool calls don't clutter the view (collapsed by default)
5. Chat input is always accessible for follow-ups
6. Plan is easily accessible via slide-out when needed
7. Single scroll area is easier to follow than two-panel layout
