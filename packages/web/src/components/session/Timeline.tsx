import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { ChatMessage } from "@/types";
import type { SessionState } from "@codevil/shared";
import type { QuestionViewModel } from "@/stores/session-store";
import {
  assignParticipantAvatarColors,
  getParticipantColorKey,
  type AvatarParticipant,
} from "@/lib/avatar-colors";
import { TimelineItem, type TimelineItemData } from "./TimelineItem";
import type { MilestoneData } from "./MilestoneCard";
import type { AttentionData } from "./AttentionCard";
import {
  getTimelineFollowStateAfterJump,
  getTimelineFollowStateAfterScroll,
} from "./timeline-scroll";

// ─── Timeline derivation ────────────────────────────────────────────────────

/**
 * Sortable wrapper so messages and questions can interleave by timestamp
 * without losing their type when we hand them to TimelineItem.
 */
type TimelineSource =
  | { kind: "message"; ts: number; msg: ChatMessage }
  | { kind: "question"; ts: number; q: QuestionViewModel };

export function deriveTimeline(
  messages: ChatMessage[],
  questions: QuestionViewModel[] = [],
): TimelineItemData[] {
  const items: TimelineItemData[] = [];
  // Unify messages + questions on a single timeline ordered by timestamp.
  // Questions tie-break after messages at the same instant so an answered
  // question never appears above the user message that triggered it.
  const sources: TimelineSource[] = [
    ...messages.map<TimelineSource>((msg) => ({ kind: "message", ts: msg.timestamp, msg })),
    ...questions.map<TimelineSource>((q) => ({ kind: "question", ts: q.raisedAt, q })),
  ].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.kind === b.kind) return 0;
    return a.kind === "message" ? -1 : 1;
  });

  for (const src of sources) {
    if (src.kind === "question") {
      items.push({ id: `q-${src.q.requestId}`, type: "question", data: src.q });
      continue;
    }
    const msg = src.msg;

    if (msg.variant === "plan") {
      items.push({ id: `msg-${msg.id}`, type: "message", data: msg });
      continue;
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
      continue;
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
      continue;
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
      continue;
    }

    if (msg.role === "system" && msg.variant === "status") continue;
    items.push({ id: `msg-${msg.id}`, type: "message", data: msg });
  }
  return items;
}

function messageSenderKey(msg: ChatMessage): string | null {
  if (msg.role === "assistant") return "agent";
  if (msg.role === "user") return `user:${msg.meta?.actor_id ?? msg.actor ?? "You"}`;
  return null;
}

function deriveAvatarParticipants(
  participants: AvatarParticipant[],
  messages: ChatMessage[],
): AvatarParticipant[] {
  const seen = new Set<string>();
  const ordered: AvatarParticipant[] = [];
  const add = (participant: AvatarParticipant) => {
    const key = getParticipantColorKey(participant);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(participant);
  };

  participants.forEach(add);
  messages.forEach((message) => {
    if (message.role !== "user") return;
    const name = message.actor || "You";
    add({ id: message.meta?.actor_id ?? name, name });
  });

  return ordered;
}

// ─── Agent working indicator ────────────────────────────────────────────────

const WORKING_PHASE_LABEL: Partial<Record<SessionState, string>> = {
  planning: "Planning",
  refining: "Refining the plan",
  executing: "Working",
  verifying: "Verifying",
  retrying: "Retrying",
  creating_pr: "Opening a pull request",
};

function getWorkingLabel(phase: SessionState | null): string | null {
  return phase ? WORKING_PHASE_LABEL[phase] ?? null : null;
}

// ─── Timeline component ─────────────────────────────────────────────────────

interface TimelineProps {
  onOpenActivity: (id: string) => void;
}

export function Timeline({ onOpenActivity }: TimelineProps) {
  const { messages, participants, sessionPhase, questions } = useSessionStore();
  const workingLabel = getWorkingLabel(sessionPhase);
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

  const items = useMemo(() => deriveTimeline(messages, questions), [messages, questions]);
  const groupedIds = useMemo(() => {
    const set = new Set<string>();
    let prevKey: string | null = null;
    for (const item of items) {
      if (item.type === "message" && item.data.variant !== "plan" && item.data.role !== "system") {
        const key = messageSenderKey(item.data);
        if (key && key === prevKey) set.add(item.id);
        prevKey = key;
      } else {
        prevKey = null;
      }
    }
    return set;
  }, [items]);
  const avatarColors = useMemo(
    () => assignParticipantAvatarColors(deriveAvatarParticipants(participants, messages)),
    [messages, participants],
  );

  const contentKey = useMemo(() => {
    const lastMessage = messages[messages.length - 1];
    const lastQuestion = questions[questions.length - 1];
    return [
      items.length,
      lastMessage?.id,
      lastMessage?.content,
      lastQuestion?.requestId,
      lastQuestion?.status,
      workingLabel ?? "",
    ].join("|");
  }, [items.length, messages, questions, workingLabel]);

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
              avatarColors={avatarColors}
              grouped={groupedIds.has(item.id)}
            />
          ))
        )}
        {workingLabel && (
          <div className="timeline-working" aria-live="polite">
            <div className="timeline-msg-avatar agent" aria-hidden="true">C</div>
            <div className="timeline-working-body">
              <div className="timeline-msg-meta">
                <span className="timeline-msg-sender">Codevil</span>
                <span>·</span>
                <span>{workingLabel}</span>
              </div>
              <div className="timeline-working-bubble" aria-label={`Codevil is working — ${workingLabel}`}>
                <span className="timeline-working-dot" />
                <span className="timeline-working-dot" />
                <span className="timeline-working-dot" />
              </div>
            </div>
          </div>
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
