# Session UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-panel session view with a single-column, monitoring-first interface featuring a status strip, unified timeline, and slide-out plan panel.

**Architecture:** Single-column layout with fixed zones (top bar, status strip, chat input) and a scrollable timeline in between. Timeline items are derived from existing `messages` and `activityLog` store data, transformed into a unified `TimelineItem[]`. Smart scroll follows new content unless user has scrolled up.

**Tech Stack:** React, TypeScript, Zustand (existing store), CSS (existing theme variables)

---

## File Structure

### New Files
- `packages/web/src/types/timeline.ts` - Timeline item type definitions
- `packages/web/src/lib/timeline-transform.ts` - Transform messages/activity to timeline items
- `packages/web/src/components/session/status-strip.tsx` - Live activity display
- `packages/web/src/components/session/timeline.tsx` - Scrollable timeline container
- `packages/web/src/components/session/trace-group.tsx` - Collapsed/expanded trace group
- `packages/web/src/components/session/milestone-card.tsx` - Milestone rendering
- `packages/web/src/components/session/attention-card.tsx` - Attention item with actions
- `packages/web/src/components/session/agent-message.tsx` - Agent message bubble
- `packages/web/src/components/session/chat-input.tsx` - Fixed chat input
- `packages/web/src/components/session/plan-slide-out.tsx` - Slide-out plan panel
- `packages/web/src/lib/__tests__/timeline-transform.test.ts` - Transform tests

### Files to Modify
- `packages/web/src/routes/session.$id.tsx` - New layout structure
- `packages/web/src/components/session/session-top-bar.tsx` - Add status badge, update styling
- `packages/web/src/session-components.css` - New component styles

### Files to Remove (after implementation complete)
- `packages/web/src/components/session/left-pane.tsx`
- `packages/web/src/components/session/inspector-pane.tsx`
- `packages/web/src/components/session/inspector-header.tsx`
- `packages/web/src/components/session/turns-list.tsx`
- `packages/web/src/components/session/detail-panel.tsx`
- `packages/web/src/components/session/conversation-panel.tsx`

---

### Task 1: Timeline Type Definitions

**Files:**
- Create: `packages/web/src/types/timeline.ts`

- [ ] **Step 1: Create timeline types file**

```typescript
// packages/web/src/types/timeline.ts
import type { ActivityEntry, ChatMessage } from "../types";

export type TimelineItemType = "milestone" | "trace-group" | "message" | "attention";

export interface BaseTimelineItem {
  id: string;
  type: TimelineItemType;
  timestamp: number;
}

export interface MilestoneItem extends BaseTimelineItem {
  type: "milestone";
  kind: "plan-approved" | "tests-passing" | "pr-created" | "complete";
  title: string;
  subtitle?: string;
  actionLabel?: string;
  planContent?: string;
}

export interface TraceGroupItem extends BaseTimelineItem {
  type: "trace-group";
  entries: ActivityEntry[];
  summary: {
    reads: number;
    writes: number;
    thinking: number;
    other: number;
    total: number;
  };
}

export interface MessageItem extends BaseTimelineItem {
  type: "message";
  role: "user" | "assistant";
  content: string;
}

export interface AttentionItem extends BaseTimelineItem {
  type: "attention";
  kind: "approval-needed" | "verification-failed" | "error" | "waiting-input";
  title: string;
  description: string;
  sourceMessage?: ChatMessage;
}

export type TimelineItem = MilestoneItem | TraceGroupItem | MessageItem | AttentionItem;

export interface CurrentActivity {
  reasoning: string | null;
  toolCall: {
    name: string;
    badge: string;
    summary: string;
    args?: string;
  } | null;
  status: "idle" | "running" | "success" | "error";
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/types/timeline.ts
git commit -m "feat: add timeline type definitions for session UI redesign"
```

---

### Task 2: Timeline Transform Logic

**Files:**
- Create: `packages/web/src/lib/timeline-transform.ts`
- Create: `packages/web/src/lib/__tests__/timeline-transform.test.ts`

- [ ] **Step 1: Write failing test for buildTimelineItems**

```typescript
// packages/web/src/lib/__tests__/timeline-transform.test.ts
import { describe, it, expect } from "vitest";
import { buildTimelineItems, getCurrentActivity } from "../timeline-transform";
import type { ChatMessage, ActivityEntry } from "../../types";

describe("buildTimelineItems", () => {
  it("returns empty array for empty inputs", () => {
    const result = buildTimelineItems([], []);
    expect(result).toEqual([]);
  });

  it("converts plan message to milestone", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg1",
        role: "assistant",
        variant: "plan",
        content: "Implementation Plan: Fix bug",
        timestamp: 1000,
      },
    ];
    const result = buildTimelineItems(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("milestone");
    expect((result[0] as any).kind).toBe("plan-approved");
  });

  it("converts complete message to milestone", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg1",
        role: "assistant",
        variant: "complete",
        content: "Session complete",
        timestamp: 1000,
      },
    ];
    const result = buildTimelineItems(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("milestone");
    expect((result[0] as any).kind).toBe("complete");
  });

  it("converts error message to attention item", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg1",
        role: "assistant",
        variant: "error",
        content: "Something went wrong",
        timestamp: 1000,
      },
    ];
    const result = buildTimelineItems(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("attention");
    expect((result[0] as any).kind).toBe("error");
  });

  it("converts verification_failed to attention item", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg1",
        role: "assistant",
        variant: "verification_failed",
        content: "Tests failed",
        timestamp: 1000,
        meta: { last_error: "AssertionError" },
      },
    ];
    const result = buildTimelineItems(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("attention");
    expect((result[0] as any).kind).toBe("verification-failed");
  });

  it("converts text message to message item", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg1",
        role: "assistant",
        variant: "text",
        content: "Working on it",
        timestamp: 1000,
      },
    ];
    const result = buildTimelineItems(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("message");
  });

  it("groups consecutive tool calls into trace group", () => {
    const activityLog: ActivityEntry[] = [
      { id: "a1", kind: "tool_call", status: "success", timestamp: 1000, tool: { name: "read", summary: "Read file" } },
      { id: "a2", kind: "tool_call", status: "success", timestamp: 1001, tool: { name: "read", summary: "Read file" } },
      { id: "a3", kind: "thinking", status: "success", timestamp: 1002, thinking: { text: "thinking" } },
    ];
    const result = buildTimelineItems([], activityLog);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("trace-group");
    expect((result[0] as any).entries).toHaveLength(3);
  });

  it("breaks trace group when message appears", () => {
    const messages: ChatMessage[] = [
      { id: "msg1", role: "assistant", variant: "text", content: "Done", timestamp: 1005 },
    ];
    const activityLog: ActivityEntry[] = [
      { id: "a1", kind: "tool_call", status: "success", timestamp: 1000, tool: { name: "read", summary: "Read" } },
      { id: "a2", kind: "tool_call", status: "success", timestamp: 1010, tool: { name: "write", summary: "Write" } },
    ];
    const result = buildTimelineItems(messages, activityLog);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("sorts items by timestamp", () => {
    const messages: ChatMessage[] = [
      { id: "msg1", role: "assistant", variant: "text", content: "Second", timestamp: 2000 },
      { id: "msg2", role: "assistant", variant: "text", content: "First", timestamp: 1000 },
    ];
    const result = buildTimelineItems(messages, []);
    expect(result[0].timestamp).toBe(1000);
    expect(result[1].timestamp).toBe(2000);
  });
});

describe("getCurrentActivity", () => {
  it("returns idle when no activity", () => {
    const result = getCurrentActivity([]);
    expect(result.status).toBe("idle");
    expect(result.reasoning).toBeNull();
    expect(result.toolCall).toBeNull();
  });

  it("returns running tool call", () => {
    const activityLog: ActivityEntry[] = [
      { id: "a1", kind: "tool_call", status: "running", timestamp: 1000, tool: { name: "read", summary: "Reading file.ts" } },
    ];
    const result = getCurrentActivity(activityLog);
    expect(result.status).toBe("running");
    expect(result.toolCall?.name).toBe("read");
  });

  it("extracts reasoning from recent thinking", () => {
    const activityLog: ActivityEntry[] = [
      { id: "a1", kind: "thinking", status: "success", timestamp: 1000, thinking: { text: "I need to check the config" } },
      { id: "a2", kind: "tool_call", status: "running", timestamp: 1001, tool: { name: "read", summary: "Reading config.ts" } },
    ];
    const result = getCurrentActivity(activityLog);
    expect(result.reasoning).toBe("I need to check the config");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/web && npm test -- --run timeline-transform
```

Expected: FAIL with "Cannot find module '../timeline-transform'"

- [ ] **Step 3: Implement timeline transform**

```typescript
// packages/web/src/lib/timeline-transform.ts
import type { ChatMessage, ActivityEntry } from "../types";
import type {
  TimelineItem,
  MilestoneItem,
  TraceGroupItem,
  MessageItem,
  AttentionItem,
  CurrentActivity,
} from "../types/timeline";

export function buildTimelineItems(
  messages: ChatMessage[],
  activityLog: ActivityEntry[]
): TimelineItem[] {
  const items: TimelineItem[] = [];

  // Convert messages to timeline items
  for (const msg of messages) {
    const item = messageToTimelineItem(msg);
    if (item) items.push(item);
  }

  // Group activity entries into trace groups, breaking on message timestamps
  const messageTimestamps = new Set(messages.map((m) => m.timestamp));
  const milestoneTimestamps = new Set(
    messages
      .filter((m) => m.variant === "plan" || m.variant === "complete")
      .map((m) => m.timestamp)
  );

  let currentGroup: ActivityEntry[] = [];
  let groupStartTime = 0;

  for (const entry of activityLog) {
    if (entry.kind !== "tool_call" && entry.kind !== "thinking") continue;

    // Check if a message or milestone breaks the group
    const shouldBreak = [...messageTimestamps].some(
      (t) => t > groupStartTime && t < entry.timestamp
    );

    if (shouldBreak && currentGroup.length > 0) {
      items.push(createTraceGroup(currentGroup));
      currentGroup = [];
    }

    if (currentGroup.length === 0) {
      groupStartTime = entry.timestamp;
    }
    currentGroup.push(entry);
  }

  // Add remaining group
  if (currentGroup.length > 0) {
    items.push(createTraceGroup(currentGroup));
  }

  // Sort by timestamp
  items.sort((a, b) => a.timestamp - b.timestamp);

  return items;
}

function messageToTimelineItem(msg: ChatMessage): TimelineItem | null {
  switch (msg.variant) {
    case "plan":
      return {
        id: msg.id,
        type: "milestone",
        kind: "plan-approved",
        title: "Plan Approved",
        subtitle: msg.content.split("\n")[0],
        timestamp: msg.timestamp,
        planContent: msg.content,
      } as MilestoneItem;

    case "complete":
      return {
        id: msg.id,
        type: "milestone",
        kind: "complete",
        title: "Session Complete",
        subtitle: msg.content,
        timestamp: msg.timestamp,
      } as MilestoneItem;

    case "error":
      return {
        id: msg.id,
        type: "attention",
        kind: "error",
        title: "Error",
        description: msg.content,
        timestamp: msg.timestamp,
        sourceMessage: msg,
      } as AttentionItem;

    case "verification_failed":
      return {
        id: msg.id,
        type: "attention",
        kind: "verification-failed",
        title: "Verification Failed",
        description: msg.meta?.last_error
          ? `${msg.content}\n${msg.meta.last_error}`
          : msg.content,
        timestamp: msg.timestamp,
        sourceMessage: msg,
      } as AttentionItem;

    case "text":
    case "status":
      return {
        id: msg.id,
        type: "message",
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
        timestamp: msg.timestamp,
      } as MessageItem;

    default:
      return null;
  }
}

function createTraceGroup(entries: ActivityEntry[]): TraceGroupItem {
  const summary = { reads: 0, writes: 0, thinking: 0, other: 0, total: entries.length };

  for (const entry of entries) {
    if (entry.kind === "thinking") {
      summary.thinking++;
    } else if (entry.tool) {
      const name = entry.tool.name.toLowerCase();
      if (name.includes("read") || name.includes("view")) {
        summary.reads++;
      } else if (name.includes("write") || name.includes("edit") || name.includes("replace")) {
        summary.writes++;
      } else {
        summary.other++;
      }
    }
  }

  return {
    id: `trace-${entries[0].id}`,
    type: "trace-group",
    timestamp: entries[0].timestamp,
    entries,
    summary,
  };
}

export function getCurrentActivity(activityLog: ActivityEntry[]): CurrentActivity {
  if (activityLog.length === 0) {
    return { reasoning: null, toolCall: null, status: "idle" };
  }

  // Find the most recent running or completed entry
  const reversed = [...activityLog].reverse();
  const runningEntry = reversed.find((e) => e.status === "running");
  const latestEntry = runningEntry || reversed[0];

  // Find recent reasoning (thinking block near the current activity)
  const recentThinking = reversed.find(
    (e) => e.kind === "thinking" && e.thinking?.text
  );

  const reasoning = recentThinking?.thinking?.text || null;

  let toolCall: CurrentActivity["toolCall"] = null;
  if (latestEntry.kind === "tool_call" && latestEntry.tool) {
    const name = latestEntry.tool.name.toLowerCase();
    let badge = "TOOL";
    if (name.includes("read") || name.includes("view")) badge = "READ";
    else if (name.includes("write") || name.includes("edit")) badge = "WRITE";
    else if (name.includes("bash") || name.includes("command")) badge = "BASH";
    else if (name.includes("grep") || name.includes("search")) badge = "GREP";

    toolCall = {
      name: latestEntry.tool.name,
      badge,
      summary: latestEntry.tool.summary || latestEntry.tool.name,
      args: latestEntry.tool.args,
    };
  }

  const status = runningEntry
    ? "running"
    : latestEntry.status === "error"
    ? "error"
    : latestEntry.status === "success"
    ? "success"
    : "idle";

  return { reasoning, toolCall, status };
}

export function getToolBadgeClass(badge: string): string {
  switch (badge) {
    case "READ":
      return "badge-read";
    case "WRITE":
      return "badge-write";
    case "BASH":
      return "badge-bash";
    case "GREP":
      return "badge-grep";
    default:
      return "badge-tool";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/web && npm test -- --run timeline-transform
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/timeline-transform.ts packages/web/src/lib/__tests__/timeline-transform.test.ts
git commit -m "feat: add timeline transform logic with tests"
```

---

### Task 3: Status Strip Component

**Files:**
- Create: `packages/web/src/components/session/status-strip.tsx`
- Modify: `packages/web/src/session-components.css`

- [ ] **Step 1: Create StatusStrip component**

```tsx
// packages/web/src/components/session/status-strip.tsx
import { useSessionStore } from "@/stores/session-store";
import { useMemo } from "react";
import { getCurrentActivity, getToolBadgeClass } from "@/lib/timeline-transform";

export function StatusStrip() {
  const { activityLog, sessionPhase } = useSessionStore();

  const activity = useMemo(() => getCurrentActivity(activityLog), [activityLog]);

  const phaseProgress = useMemo(() => {
    const phases = ["planning", "executing", "completed"];
    const currentIndex = phases.findIndex((p) =>
      sessionPhase?.includes(p) || (sessionPhase === "awaiting_approval" && p === "planning")
    );
    return { phases, currentIndex };
  }, [sessionPhase]);

  const stepCount = activityLog.filter((e) => e.kind === "tool_call").length;

  return (
    <div className="status-strip">
      <div className="status-strip-main">
        <div className={`status-dot status-dot-${activity.status}`} />
        <div className="status-strip-content">
          {activity.reasoning && (
            <div className="status-reasoning">"{activity.reasoning}"</div>
          )}
          {activity.toolCall ? (
            <div className="status-tool">
              <span className={`status-badge ${getToolBadgeClass(activity.toolCall.badge)}`}>
                {activity.toolCall.badge}
              </span>
              <span className="status-tool-summary">{activity.toolCall.summary}</span>
              {activity.toolCall.args && (
                <span className="status-tool-args">{truncateArgs(activity.toolCall.args)}</span>
              )}
            </div>
          ) : (
            <div className="status-tool">
              <span className="status-tool-summary">
                {activity.status === "idle" ? "Waiting for activity..." : "Processing..."}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="status-strip-footer">
        <span className="status-phase-label">
          {sessionPhase === "awaiting_approval" ? "Awaiting approval" : sessionPhase || "Initializing"} · {stepCount} steps
        </span>
        <div className="status-phase-dots">
          {phaseProgress.phases.map((phase, i) => (
            <span
              key={phase}
              className={`status-phase-dot ${i <= phaseProgress.currentIndex ? "status-phase-dot-active" : ""}`}
            >
              {i <= phaseProgress.currentIndex ? "●" : "○"} {phase.charAt(0).toUpperCase() + phase.slice(1, 4)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function truncateArgs(args: string, maxLength = 40): string {
  if (args.length <= maxLength) return args;
  return args.slice(0, maxLength) + "...";
}
```

- [ ] **Step 2: Add StatusStrip CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Status Strip ────────────────────────────────────────────────────────── */
.status-strip {
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.status-strip-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line-2);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}

.status-dot-idle { background: var(--fg-4); }
.status-dot-running { 
  background: var(--info); 
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
}
.status-dot-success { background: var(--ok); }
.status-dot-error { 
  background: var(--err); 
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2);
}

.status-strip-content {
  flex: 1;
  min-width: 0;
}

.status-reasoning {
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.5;
  font-style: italic;
  margin-bottom: 8px;
}

.status-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 600;
  flex-shrink: 0;
}

.badge-read { background: rgba(59, 130, 246, 0.15); color: var(--info); }
.badge-write { background: rgba(34, 197, 94, 0.15); color: var(--ok); }
.badge-bash { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
.badge-grep { background: rgba(234, 179, 8, 0.15); color: #eab308; }
.badge-tool { background: var(--surface-3); color: var(--fg-3); }

.status-tool-summary {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
}

.status-tool-args {
  font-size: 10px;
  color: var(--fg-4);
  margin-left: auto;
}

.status-strip-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 16px;
  font-size: 10px;
  color: var(--fg-4);
}

.status-phase-label {
  text-transform: capitalize;
}

.status-phase-dots {
  display: flex;
  gap: 8px;
}

.status-phase-dot {
  color: var(--fg-4);
}

.status-phase-dot-active {
  color: var(--ok);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/status-strip.tsx packages/web/src/session-components.css
git commit -m "feat: add StatusStrip component with live activity display"
```

---

### Task 4: TraceGroup Component

**Files:**
- Create: `packages/web/src/components/session/trace-group.tsx`

- [ ] **Step 1: Create TraceGroup component**

```tsx
// packages/web/src/components/session/trace-group.tsx
import { useState } from "react";
import type { TraceGroupItem } from "@/types/timeline";
import type { ActivityEntry } from "@/types";

interface TraceGroupProps {
  item: TraceGroupItem;
}

export function TraceGroup({ item }: TraceGroupProps) {
  const [expanded, setExpanded] = useState(false);

  const { summary } = item;
  const duration = formatDuration(item.entries);

  return (
    <div className="trace-group">
      <button
        className="trace-group-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="trace-group-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="trace-group-count">{summary.total} tool calls</span>
        <span className="trace-group-breakdown">
          · {summary.reads > 0 && `${summary.reads} reads`}
          {summary.writes > 0 && `, ${summary.writes} edits`}
          {summary.thinking > 0 && `, ${summary.thinking} thinking`}
        </span>
        <span className="trace-group-duration">{duration}</span>
      </button>

      {expanded && (
        <div className="trace-group-entries">
          {item.entries.map((entry) => (
            <TraceEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceEntry({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === "thinking") {
    return (
      <div className="trace-entry trace-entry-thinking">
        <span className="trace-entry-icon">✦</span>
        <span className="trace-entry-type">THINKING</span>
        <span className="trace-entry-summary">
          {entry.thinking?.text?.slice(0, 60)}...
        </span>
      </div>
    );
  }

  if (entry.kind === "tool_call" && entry.tool) {
    const badge = getToolBadge(entry.tool.name);
    return (
      <div className="trace-entry">
        <span className={`trace-entry-icon trace-icon-${badge.toLowerCase()}`}>
          {badge.charAt(0)}
        </span>
        <span className="trace-entry-type">{badge}</span>
        <span className="trace-entry-summary">{entry.tool.summary || entry.tool.name}</span>
        <span className={`trace-entry-status trace-status-${entry.status}`}>
          {entry.status === "success" ? "ok" : entry.status}
        </span>
      </div>
    );
  }

  return null;
}

function getToolBadge(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("read") || lower.includes("view")) return "READ";
  if (lower.includes("write") || lower.includes("edit")) return "WRITE";
  if (lower.includes("bash") || lower.includes("command")) return "BASH";
  if (lower.includes("grep") || lower.includes("search")) return "GREP";
  return "TOOL";
}

function formatDuration(entries: ActivityEntry[]): string {
  if (entries.length < 2) return "";
  const start = entries[0].timestamp;
  const end = entries[entries.length - 1].timestamp;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
```

- [ ] **Step 2: Add TraceGroup CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Trace Group ─────────────────────────────────────────────────────────── */
.trace-group {
  margin-bottom: 8px;
}

.trace-group-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}

.trace-group-header:hover {
  background: var(--surface-3);
}

.trace-group-chevron {
  color: var(--fg-4);
  font-size: 10px;
}

.trace-group-count {
  color: var(--fg-2);
}

.trace-group-breakdown {
  color: var(--fg-4);
  font-size: 10px;
}

.trace-group-duration {
  color: var(--fg-4);
  font-size: 10px;
  margin-left: auto;
}

.trace-group-entries {
  margin-top: 4px;
  padding-left: 12px;
  border-left: 2px solid var(--line-2);
  margin-left: 6px;
}

.trace-entry {
  display: grid;
  grid-template-columns: 18px auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
}

.trace-entry:hover {
  background: var(--surface-2);
  border-radius: 4px;
}

.trace-entry-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  background: var(--surface-3);
  color: var(--fg-3);
}

.trace-icon-read { background: rgba(59, 130, 246, 0.15); color: var(--info); }
.trace-icon-write { background: rgba(34, 197, 94, 0.15); color: var(--ok); }
.trace-icon-bash { background: rgba(168, 85, 247, 0.15); color: #a855f7; }

.trace-entry-type {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-4);
}

.trace-entry-summary {
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trace-entry-status {
  font-size: 10px;
  color: var(--fg-4);
}

.trace-status-success { color: var(--ok); }
.trace-status-error { color: var(--err); }
.trace-status-running { color: var(--info); }
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/trace-group.tsx packages/web/src/session-components.css
git commit -m "feat: add TraceGroup component with expand/collapse"
```

---

### Task 5: MilestoneCard Component

**Files:**
- Create: `packages/web/src/components/session/milestone-card.tsx`

- [ ] **Step 1: Create MilestoneCard component**

```tsx
// packages/web/src/components/session/milestone-card.tsx
import type { MilestoneItem } from "@/types/timeline";

interface MilestoneCardProps {
  item: MilestoneItem;
  onViewPlan?: () => void;
}

export function MilestoneCard({ item, onViewPlan }: MilestoneCardProps) {
  const icon = getMilestoneIcon(item.kind);
  const time = formatTime(item.timestamp);

  return (
    <div className="milestone-card">
      <div className={`milestone-icon milestone-icon-${item.kind}`}>{icon}</div>
      <div className="milestone-content">
        <div className="milestone-header">
          <div>
            <div className="milestone-title">{item.title}</div>
            {item.subtitle && <div className="milestone-subtitle">{item.subtitle}</div>}
          </div>
          <span className="milestone-time">{time}</span>
        </div>
        {item.kind === "plan-approved" && onViewPlan && (
          <button className="milestone-action" onClick={onViewPlan} type="button">
            View plan →
          </button>
        )}
      </div>
    </div>
  );
}

function getMilestoneIcon(kind: MilestoneItem["kind"]): string {
  switch (kind) {
    case "plan-approved":
      return "✓";
    case "tests-passing":
      return "✓";
    case "pr-created":
      return "⎇";
    case "complete":
      return "✓";
    default:
      return "●";
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

- [ ] **Step 2: Add MilestoneCard CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Milestone Card ──────────────────────────────────────────────────────── */
.milestone-card {
  display: flex;
  gap: 12px;
  padding: 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 12px;
}

.milestone-icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  background: var(--ok);
  color: white;
}

.milestone-icon-complete {
  background: var(--ok);
}

.milestone-icon-plan-approved {
  background: var(--ok);
}

.milestone-icon-tests-passing {
  background: var(--ok);
}

.milestone-icon-pr-created {
  background: var(--info);
}

.milestone-content {
  flex: 1;
  min-width: 0;
}

.milestone-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.milestone-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--fg);
}

.milestone-subtitle {
  font-size: 12px;
  color: var(--fg-3);
  margin-top: 3px;
}

.milestone-time {
  font-size: 10px;
  color: var(--fg-4);
  flex-shrink: 0;
}

.milestone-action {
  margin-top: 10px;
  font-size: 11px;
  color: var(--accent);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}

.milestone-action:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/milestone-card.tsx packages/web/src/session-components.css
git commit -m "feat: add MilestoneCard component"
```

---

### Task 6: AttentionCard Component

**Files:**
- Create: `packages/web/src/components/session/attention-card.tsx`

- [ ] **Step 1: Create AttentionCard component**

```tsx
// packages/web/src/components/session/attention-card.tsx
import type { AttentionItem } from "@/types/timeline";
import { useSessionStore } from "@/stores/session-store";

interface AttentionCardProps {
  item: AttentionItem;
  onViewDiff?: () => void;
}

export function AttentionCard({ item, onViewDiff }: AttentionCardProps) {
  const { approve } = useSessionStore();

  const handleApprove = () => {
    approve();
  };

  return (
    <div className={`attention-card attention-card-${item.kind}`}>
      <div className="attention-icon">!</div>
      <div className="attention-content">
        <div className="attention-title">{item.title}</div>
        <div className="attention-description">{item.description}</div>
        <div className="attention-actions">
          {item.kind === "approval-needed" && (
            <>
              <button className="btn btn-primary" onClick={handleApprove} type="button">
                Approve & Continue
              </button>
              {onViewDiff && (
                <button className="btn btn-ghost" onClick={onViewDiff} type="button">
                  View Diff
                </button>
              )}
            </>
          )}
          {item.kind === "verification-failed" && (
            <button className="btn btn-ghost" onClick={onViewDiff} type="button">
              View Details
            </button>
          )}
          {item.kind === "error" && (
            <button className="btn btn-ghost" onClick={onViewDiff} type="button">
              View Error
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add AttentionCard CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Attention Card ──────────────────────────────────────────────────────── */
.attention-card {
  display: flex;
  gap: 12px;
  padding: 14px;
  background: rgba(245, 158, 11, 0.08);
  border: 2px solid rgba(245, 158, 11, 0.4);
  border-radius: 8px;
  margin-bottom: 12px;
}

.attention-card-error {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.4);
}

.attention-card-verification-failed {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.4);
}

.attention-icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
  background: #f59e0b;
  color: white;
}

.attention-card-error .attention-icon,
.attention-card-verification-failed .attention-icon {
  background: var(--err);
}

.attention-content {
  flex: 1;
  min-width: 0;
}

.attention-title {
  font-weight: 600;
  font-size: 13px;
  color: #d97706;
}

.attention-card-error .attention-title,
.attention-card-verification-failed .attention-title {
  color: var(--err);
}

.attention-description {
  font-size: 12px;
  color: var(--fg-2);
  margin-top: 4px;
  line-height: 1.4;
}

.attention-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/attention-card.tsx packages/web/src/session-components.css
git commit -m "feat: add AttentionCard component with action buttons"
```

---

### Task 7: AgentMessage Component

**Files:**
- Create: `packages/web/src/components/session/agent-message.tsx`

- [ ] **Step 1: Create AgentMessage component**

```tsx
// packages/web/src/components/session/agent-message.tsx
import type { MessageItem } from "@/types/timeline";

interface AgentMessageProps {
  item: MessageItem;
}

export function AgentMessage({ item }: AgentMessageProps) {
  const time = formatTime(item.timestamp);
  const isUser = item.role === "user";

  return (
    <div className={`agent-message ${isUser ? "agent-message-user" : ""}`}>
      <div className="agent-message-avatar">
        {isUser ? "U" : "✦"}
      </div>
      <div className="agent-message-body">
        <div className="agent-message-meta">
          <span className="agent-message-sender">{isUser ? "You" : "Agent"}</span>
          <span className="agent-message-time">{time}</span>
        </div>
        <div className="agent-message-bubble">
          {item.content}
        </div>
      </div>
    </div>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

- [ ] **Step 2: Add AgentMessage CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Agent Message ───────────────────────────────────────────────────────── */
.agent-message {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.agent-message-avatar {
  width: 28px;
  height: 28px;
  background: var(--surface-3);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
  color: var(--fg-3);
}

.agent-message-user .agent-message-avatar {
  background: var(--accent);
  color: white;
}

.agent-message-body {
  flex: 1;
  min-width: 0;
}

.agent-message-meta {
  font-size: 10px;
  color: var(--fg-4);
  margin-bottom: 4px;
  display: flex;
  gap: 8px;
}

.agent-message-sender {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-3);
}

.agent-message-bubble {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
}

.agent-message-user .agent-message-bubble {
  background: var(--accent-soft);
  border-color: transparent;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/agent-message.tsx packages/web/src/session-components.css
git commit -m "feat: add AgentMessage component"
```

---

### Task 8: ChatInput Component

**Files:**
- Create: `packages/web/src/components/session/chat-input.tsx`

- [ ] **Step 1: Create ChatInput component**

```tsx
// packages/web/src/components/session/chat-input.tsx
import { useState } from "react";
import { useSessionStore } from "@/stores/session-store";

export function ChatInput() {
  const [input, setInput] = useState("");
  const { refine, sessionPhase } = useSessionStore();

  const isDisabled = sessionPhase === "completed" || sessionPhase === "failed";

  const handleSubmit = () => {
    if (!input.trim() || isDisabled) return;
    refine(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="chat-input-container">
      <div className="chat-input-wrapper">
        <input
          type="text"
          className="chat-input-field"
          placeholder="Ask a question or provide feedback..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
        />
        <button
          className="chat-input-send"
          onClick={handleSubmit}
          disabled={isDisabled || !input.trim()}
          type="button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add ChatInput CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Chat Input ──────────────────────────────────────────────────────────── */
.chat-input-container {
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--surface);
  flex-shrink: 0;
}

.chat-input-wrapper {
  display: flex;
  gap: 8px;
}

.chat-input-field {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12px;
  background: var(--bg);
  color: var(--fg);
  outline: none;
}

.chat-input-field:focus {
  border-color: var(--accent);
}

.chat-input-field:disabled {
  background: var(--surface-2);
  color: var(--fg-4);
  cursor: not-allowed;
}

.chat-input-send {
  padding: 10px 14px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg-3);
  cursor: pointer;
}

.chat-input-send:hover:not(:disabled) {
  background: var(--surface-3);
}

.chat-input-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/chat-input.tsx packages/web/src/session-components.css
git commit -m "feat: add ChatInput component"
```

---

### Task 9: Timeline Component with Smart Scroll

**Files:**
- Create: `packages/web/src/components/session/timeline.tsx`

- [ ] **Step 1: Create Timeline component**

```tsx
// packages/web/src/components/session/timeline.tsx
import { useEffect, useRef, useMemo, useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import { buildTimelineItems } from "@/lib/timeline-transform";
import type { TimelineItem } from "@/types/timeline";
import { TraceGroup } from "./trace-group";
import { MilestoneCard } from "./milestone-card";
import { AttentionCard } from "./attention-card";
import { AgentMessage } from "./agent-message";

interface TimelineProps {
  onViewPlan: (content: string) => void;
}

export function Timeline({ onViewPlan }: TimelineProps) {
  const { messages, activityLog } = useSessionStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const lastItemCountRef = useRef(0);

  const items = useMemo(
    () => buildTimelineItems(messages, activityLog),
    [messages, activityLog]
  );

  // Track if user is at bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 100;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Smart scroll: follow if at bottom, interrupt for attention items
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newItemCount = items.length;
    const hasNewItems = newItemCount > lastItemCountRef.current;
    lastItemCountRef.current = newItemCount;

    if (!hasNewItems) return;

    // Check for attention items that should interrupt
    const lastItem = items[items.length - 1];
    const shouldInterrupt = lastItem?.type === "attention" || 
      (lastItem?.type === "milestone" && lastItem.kind !== "complete");

    if (shouldInterrupt || isAtBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [items]);

  const handleViewPlan = useCallback((content: string) => {
    onViewPlan(content);
  }, [onViewPlan]);

  return (
    <div className="timeline" ref={scrollRef} onScroll={handleScroll}>
      <div className="timeline-inner">
        {items.map((item) => (
          <TimelineItemRenderer
            key={item.id}
            item={item}
            onViewPlan={handleViewPlan}
          />
        ))}
        {items.length === 0 && (
          <div className="timeline-empty">
            <span>Waiting for activity...</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface TimelineItemRendererProps {
  item: TimelineItem;
  onViewPlan: (content: string) => void;
}

function TimelineItemRenderer({ item, onViewPlan }: TimelineItemRendererProps) {
  switch (item.type) {
    case "milestone":
      return (
        <MilestoneCard
          item={item}
          onViewPlan={item.planContent ? () => onViewPlan(item.planContent!) : undefined}
        />
      );
    case "trace-group":
      return <TraceGroup item={item} />;
    case "attention":
      return <AttentionCard item={item} />;
    case "message":
      return <AgentMessage item={item} />;
    default:
      return null;
  }
}
```

- [ ] **Step 2: Add Timeline CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Timeline ────────────────────────────────────────────────────────────── */
.timeline {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.timeline-inner {
  padding: 16px;
}

.timeline-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--fg-4);
  font-size: 12px;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/timeline.tsx packages/web/src/session-components.css
git commit -m "feat: add Timeline component with smart scroll"
```

---

### Task 10: PlanSlideOut Component

**Files:**
- Create: `packages/web/src/components/session/plan-slide-out.tsx`

- [ ] **Step 1: Create PlanSlideOut component**

```tsx
// packages/web/src/components/session/plan-slide-out.tsx
import { useEffect } from "react";
import { parsePlanMarkdown, type PlanSections } from "@/lib/plan-markdown";

interface PlanSlideOutProps {
  content: string;
  onClose: () => void;
}

export function PlanSlideOut({ content, onClose }: PlanSlideOutProps) {
  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const plan = parsePlanMarkdown(content);

  return (
    <div className="plan-slideout-backdrop" onClick={onClose}>
      <div className="plan-slideout" onClick={(e) => e.stopPropagation()}>
        <div className="plan-slideout-header">
          <h2 className="plan-slideout-title">{plan.title || "Implementation Plan"}</h2>
          <button className="plan-slideout-close" onClick={onClose} type="button">
            ✕
          </button>
        </div>
        <div className="plan-slideout-body">
          <PlanContent plan={plan} />
        </div>
      </div>
    </div>
  );
}

function PlanContent({ plan }: { plan: PlanSections }) {
  return (
    <div className="plan-content">
      {plan.objective && (
        <section className="plan-section">
          <h3>Objective</h3>
          <p>{plan.objective}</p>
        </section>
      )}

      {plan.steps && plan.steps.length > 0 && (
        <section className="plan-section">
          <h3>Steps</h3>
          <table className="plan-steps-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Step</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {plan.steps.map((step, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{step.step}</td>
                  <td>{step.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {plan.rollback && (
        <section className="plan-section">
          <h3>Rollback</h3>
          <p>{plan.rollback}</p>
        </section>
      )}

      {plan.riskAssessment && (
        <section className="plan-section">
          <h3>Risk Assessment</h3>
          <p>{plan.riskAssessment}</p>
        </section>
      )}

      {!plan.objective && !plan.steps?.length && (
        <div className="plan-raw">
          <pre>{plan.raw}</pre>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add PlanSlideOut CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Plan Slide Out ──────────────────────────────────────────────────────── */
.plan-slideout-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 100;
  display: flex;
  justify-content: flex-end;
}

.plan-slideout {
  width: min(600px, 50vw);
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  animation: slideIn 0.2s ease-out;
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.plan-slideout-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}

.plan-slideout-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.plan-slideout-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fg-3);
}

.plan-slideout-close:hover {
  background: var(--surface-3);
}

.plan-slideout-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.plan-content {
  font-size: 13px;
  line-height: 1.6;
}

.plan-section {
  margin-bottom: 24px;
}

.plan-section h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-3);
  margin: 0 0 8px;
}

.plan-section p {
  margin: 0;
  color: var(--fg-2);
}

.plan-steps-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.plan-steps-table th,
.plan-steps-table td {
  padding: 8px;
  text-align: left;
  border-bottom: 1px solid var(--line-2);
}

.plan-steps-table th {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-4);
  font-weight: 500;
}

.plan-steps-table td:first-child {
  width: 30px;
  color: var(--fg-4);
}

.plan-raw pre {
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg-2);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/plan-slide-out.tsx packages/web/src/session-components.css
git commit -m "feat: add PlanSlideOut component"
```

---

### Task 11: Update Session Route Layout

**Files:**
- Modify: `packages/web/src/routes/session.$id.tsx`

- [ ] **Step 1: Update session page with new layout**

```tsx
// packages/web/src/routes/session.$id.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import { loadConfig } from "@/lib/config";
import { SessionTopBar } from "@/components/session/session-top-bar";
import { StatusStrip } from "@/components/session/status-strip";
import { Timeline } from "@/components/session/timeline";
import { ChatInput } from "@/components/session/chat-input";
import { PlanSlideOut } from "@/components/session/plan-slide-out";

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const { connectToSession, disconnect } = useSessionStore();
  const [planContent, setPlanContent] = useState<string | null>(null);

  useEffect(() => {
    const config = loadConfig();
    if (config) {
      const wsUrl = `${config.endpoint}/sessions/${id}/ws`;
      connectToSession(config, id, wsUrl);
    }
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleViewPlan = useCallback((content: string) => {
    setPlanContent(content);
  }, []);

  const handleClosePlan = useCallback(() => {
    setPlanContent(null);
  }, []);

  return (
    <div className="session-shell">
      <SessionTopBar />
      <StatusStrip />
      <Timeline onViewPlan={handleViewPlan} />
      <ChatInput />
      {planContent && (
        <PlanSlideOut content={planContent} onClose={handleClosePlan} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update session layout CSS**

In `packages/web/src/session-components.css`, update the session shell:

```css
/* ─── Layout ──────────────────────────────────────────────────────────────── */
.session-shell {
  height: 100vh;
  width: 100vw;
  background: var(--bg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

Remove or comment out the old `.session-body` grid styles:

```css
/* REMOVED - old two-column layout
.session-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(520px, 1fr);
  min-height: 0;
}
*/
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/routes/session.\$id.tsx packages/web/src/session-components.css
git commit -m "feat: update session page with new single-column layout"
```

---

### Task 12: Update SessionTopBar

**Files:**
- Modify: `packages/web/src/components/session/session-top-bar.tsx`

- [ ] **Step 1: Update SessionTopBar with status badge**

```tsx
// packages/web/src/components/session/session-top-bar.tsx
import { useSessionStore } from "@/stores/session-store";

export function SessionTopBar() {
  const { sessionId, sessionPhase, messages } = useSessionStore();

  const cost = [...messages].reverse().find((m) => m.meta?.cost)?.meta?.cost;
  const model = [...messages].reverse().find((m) => m.meta?.model)?.meta?.model;

  const statusBadge = getStatusBadge(sessionPhase);

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="logo-mark">
          <span />
        </div>
        <div className="topbar-title">
          <span>codevil</span>
          <span className="topbar-sep">/</span>
          <span className="topbar-session">{sessionId?.slice(0, 16) || "..."}</span>
        </div>
        {statusBadge && (
          <span className={`topbar-badge topbar-badge-${statusBadge.color}`}>
            {statusBadge.label}
          </span>
        )}
      </div>
      <div className="topbar-right">
        {model && <span className="topbar-meta">{model}</span>}
        <span className="topbar-meta">
          {cost ? `$${cost.total_cost_usd.toFixed(4)}` : "$0.00"}
        </span>
        <ElapsedTime />
      </div>
    </div>
  );
}

function getStatusBadge(phase: string | null): { label: string; color: string } | null {
  switch (phase) {
    case "initializing":
      return { label: "INIT", color: "gray" };
    case "planning":
    case "awaiting_approval":
      return { label: "PLANNING", color: "blue" };
    case "executing":
    case "verifying":
      return { label: "EXECUTING", color: "green" };
    case "completed":
      return { label: "DONE", color: "green" };
    case "failed":
      return { label: "ERROR", color: "red" };
    default:
      return null;
  }
}

function ElapsedTime() {
  // Simple elapsed time display - could be enhanced with actual tracking
  return <span className="topbar-meta">--:--</span>;
}
```

- [ ] **Step 2: Add topbar badge CSS**

Add to `packages/web/src/session-components.css`:

```css
/* ─── Topbar Badge ────────────────────────────────────────────────────────── */
.topbar-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.topbar-badge-gray {
  background: var(--surface-3);
  color: var(--fg-3);
}

.topbar-badge-blue {
  background: rgba(59, 130, 246, 0.15);
  color: var(--info);
}

.topbar-badge-green {
  background: rgba(34, 197, 94, 0.15);
  color: var(--ok);
}

.topbar-badge-red {
  background: rgba(239, 68, 68, 0.15);
  color: var(--err);
}

.topbar-meta {
  font-size: 11px;
  color: var(--fg-3);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session/session-top-bar.tsx packages/web/src/session-components.css
git commit -m "feat: update SessionTopBar with status badge"
```

---

### Task 13: Export New Components

**Files:**
- Modify: Component imports where needed

- [ ] **Step 1: Verify all imports work**

Run the dev server to check for import errors:

```bash
cd packages/web && npm run dev
```

- [ ] **Step 2: Fix any import path issues**

If there are issues with the `@/types/timeline` import, ensure the path alias is correctly configured or use relative imports.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve import paths for new components"
```

---

### Task 14: Remove Old Components

**Files:**
- Remove: `packages/web/src/components/session/left-pane.tsx`
- Remove: `packages/web/src/components/session/inspector-pane.tsx`
- Remove: `packages/web/src/components/session/inspector-header.tsx`
- Remove: `packages/web/src/components/session/turns-list.tsx`
- Remove: `packages/web/src/components/session/detail-panel.tsx`
- Remove: `packages/web/src/components/session/conversation-panel.tsx`

- [ ] **Step 1: Verify app works without old components**

```bash
cd packages/web && npm run dev
```

Open browser and verify session page loads correctly.

- [ ] **Step 2: Remove old component files**

```bash
rm packages/web/src/components/session/left-pane.tsx
rm packages/web/src/components/session/inspector-pane.tsx
rm packages/web/src/components/session/inspector-header.tsx
rm packages/web/src/components/session/turns-list.tsx
rm packages/web/src/components/session/detail-panel.tsx
rm packages/web/src/components/session/conversation-panel.tsx
```

- [ ] **Step 3: Remove unused CSS**

Remove old component CSS from `session-components.css` (leftpane, rp-insp, insp-* classes, etc.)

- [ ] **Step 4: Commit removal**

```bash
git add -A
git commit -m "chore: remove deprecated session components"
```

---

### Task 15: Final Testing and Cleanup

- [ ] **Step 1: Run type check**

```bash
cd packages/web && npm run typecheck
```

- [ ] **Step 2: Run tests**

```bash
cd packages/web && npm test
```

- [ ] **Step 3: Manual testing**

Open the app and verify:
1. Status strip shows live activity with reasoning
2. Timeline shows milestones, collapsed traces, messages
3. Attention items are highlighted and have working buttons
4. Plan slide-out opens and closes correctly
5. Chat input works for sending messages
6. Smart scroll follows new content when at bottom
7. Scroll stays in place when user has scrolled up

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete session UI redesign implementation"
```
