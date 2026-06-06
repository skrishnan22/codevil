import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { ActivityEntry, ChatMessage } from "@/types";
import { TimelineItem, type TimelineItemData } from "./TimelineItem";
import type { MilestoneData } from "./MilestoneCard";
import type { AttentionData } from "./AttentionCard";
import type { TraceGroupData } from "./TraceGroup";
import {
  getTimelineFollowStateAfterJump,
  getTimelineFollowStateAfterScroll,
} from "./timeline-scroll";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTraceEntry(entry: ActivityEntry): boolean {
  return entry.kind === "tool_call" || entry.kind === "thinking";
}

function classifyEntry(entry: ActivityEntry): "read" | "write" | "bash" | "thinking" | "other" {
  if (entry.kind === "thinking") return "thinking";
  const name = entry.tool?.name.toLowerCase() ?? "";
  if (name.includes("read") || name.includes("view") || name.includes("grep") || name.includes("list") || name.includes("ls") || name.includes("search")) return "read";
  if (name.includes("write") || name.includes("edit") || name.includes("replace")) return "write";
  if (name.includes("bash") || name.includes("command") || name.includes("run")) return "bash";
  return "other";
}

function buildTraceGroup(entries: ActivityEntry[]): TraceGroupData {
  const summary = { reads: 0, writes: 0, thinking: 0, bash: 0, other: 0 };
  for (const e of entries) {
    const cls = classifyEntry(e);
    if (cls === "read") summary.reads++;
    else if (cls === "write") summary.writes++;
    else if (cls === "thinking") summary.thinking++;
    else if (cls === "bash") summary.bash++;
    else summary.other++;
  }
  return {
    id: entries[0].id,
    entries,
    summary,
  };
}

// ─── Timeline derivation ────────────────────────────────────────────────────

function deriveTimeline(
  activityLog: ActivityEntry[],
  messages: ChatMessage[],
): TimelineItemData[] {
  const items: TimelineItemData[] = [];

  // Build a map: timestamp → messages at that point
  // We'll interleave messages by timestamp as we walk the activity log.
  // First, separate messages by variant.
  const messagesSorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  // Track which messages have been emitted
  const emitted = new Set<string>();

  // Flush messages that occurred before `ts`
  function flushMessages(beforeTs: number) {
    for (const msg of messagesSorted) {
      if (emitted.has(msg.id)) continue;
      if (msg.timestamp > beforeTs) break;
      emitted.add(msg.id);
      emitMessage(msg);
    }
  }

  function emitMessage(msg: ChatMessage) {
    if (msg.variant === "plan") {
      items.push({ id: `msg-${msg.id}`, type: "message", data: msg });
      return;
    }

    if (msg.variant === "complete") {
      const milestone: MilestoneData = {
        id: `ms-complete-${msg.id}`,
        kind: "complete",
        title: "Session complete",
        subtitle: msg.meta?.pr_url ? `PR: ${msg.meta.pr_url}` : msg.content.slice(0, 80),
        timestamp: msg.timestamp,
        action: msg.meta?.pr_url
          ? { label: "View PR", handler: () => window.open(msg.meta!.pr_url, "_blank") }
          : undefined,
      };
      items.push({ id: milestone.id, type: "milestone", data: milestone });
      return;
    }

    if (msg.variant === "error") {
      const attention: AttentionData = {
        id: `attn-error-${msg.id}`,
        kind: "error",
        title: "Session error",
        description: msg.content,
        actions: [],
      };
      items.push({ id: attention.id, type: "attention", data: attention });
      return;
    }

    if (msg.variant === "verification_failed") {
      const attention: AttentionData = {
        id: `attn-vf-${msg.id}`,
        kind: "verification-failed",
        title: "Verification failed",
        description: msg.meta?.last_error
          ? `${msg.content}\n${msg.meta.last_error}`
          : msg.content,
        actions: [],
      };
      items.push({ id: attention.id, type: "attention", data: attention });
      return;
    }

    // Regular text/status/phase message
    items.push({ id: `msg-${msg.id}`, type: "message", data: msg });
  }

  // Walk activity log and group consecutive trace entries
  let traceBuffer: ActivityEntry[] = [];

  function flushTraceBuffer() {
    if (traceBuffer.length === 0) return;
    const group = buildTraceGroup(traceBuffer);
    items.push({ id: `tg-${group.id}`, type: "trace-group", data: group });
    traceBuffer = [];
  }

  for (const entry of activityLog) {
    const ts = entry.timestamp;

    if (isTraceEntry(entry)) {
      // Flush any messages that predate this entry
      flushMessages(ts - 1);
      traceBuffer.push(entry);
    } else {
      // Non-trace entry (phase_divider, event) — flush the current group first
      flushTraceBuffer();
      flushMessages(ts);

      // phase_divider and event entries are ignored for now (they influence milestones via messages)
    }
  }

  // Flush final trace buffer
  flushTraceBuffer();

  // Flush any remaining messages
  for (const msg of messagesSorted) {
    if (!emitted.has(msg.id)) {
      emitted.add(msg.id);
      emitMessage(msg);
    }
  }

  return items;
}

// ─── Timeline component ─────────────────────────────────────────────────────

interface TimelineProps {
  onOpenActivity: (id: string) => void;
}

export function Timeline({ onOpenActivity }: TimelineProps) {
  const { activityLog, messages } = useSessionStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [latestAttentionId, setLatestAttentionId] = useState<string | null>(null);
  const isFollowingLatestRef = useRef(true);
  const previousContentKeyRef = useRef("");

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const items = useMemo(
    () => deriveTimeline(activityLog, messages),
    [activityLog, messages],
  );

  const contentKey = useMemo(() => {
    const lastMessage = messages[messages.length - 1];
    const lastActivity = activityLog[activityLog.length - 1];
    return [
      items.length,
      lastMessage?.id,
      lastMessage?.content,
      lastActivity?.id,
      lastActivity?.status,
      lastActivity?.thinking?.text,
      lastActivity?.tool?.result,
      lastActivity?.tool?.error,
    ].join("|");
  }, [activityLog, items.length, messages]);

  useEffect(() => {
    const latestAttention = [...items].reverse().find((i) => i.type === "attention");
    if (latestAttention && latestAttention.id !== latestAttentionId) {
      setLatestAttentionId(latestAttention.id);
      if (isFollowingLatestRef.current) {
        setTimeout(() => {
          const el = document.getElementById(
            `attention-${latestAttention.data.id}`,
          );
          el?.scrollIntoView({ block: "center" });
        }, 50);
        return;
      }
    }

    if (isFollowingLatestRef.current && contentKey !== previousContentKeyRef.current) {
      requestAnimationFrame(scrollToBottom);
    }
    previousContentKeyRef.current = contentKey;
  }, [contentKey, items, latestAttentionId, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = getTimelineFollowStateAfterScroll({
      distanceFromBottom: distFromBottom,
    });
    isFollowingLatestRef.current = next.isFollowingLatest;
    setIsNearBottom(next.isNearBottom);
  }, []);

  function handleJumpToLatest() {
    const next = getTimelineFollowStateAfterJump();
    isFollowingLatestRef.current = next.isFollowingLatest;
    setIsNearBottom(next.isNearBottom);
    scrollToBottom();
  }

  return (
    <div
      className="timeline scroll"
      ref={scrollRef}
      onScroll={handleScroll}
      aria-label="Session timeline"
    >
      <div className="conversation-label">Conversation</div>
      <div className="timeline-inner">
        {items.length === 0 ? (
          <div className="timeline-empty">
            <div className="timeline-empty-glyph">◌</div>
            <div className="timeline-empty-text">Waiting for agent to begin…</div>
          </div>
        ) : (
          items.map((item) => (
            <TimelineItem
              key={item.id}
              item={item}
              highlight={item.id === latestAttentionId}
              onOpenActivity={onOpenActivity}
            />
          ))
        )}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
      {!isNearBottom && (
        <button className="timeline-jump-latest" type="button" onClick={handleJumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
