import type { ChatMessage } from "@/types";
import { MilestoneCard, type MilestoneData } from "./MilestoneCard";
import { AttentionCard, type AttentionData } from "./AttentionCard";
import { TraceGroup, type TraceGroupData } from "./TraceGroup";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function getTimelineMessagePresentation(msg: ChatMessage): {
  kind: "human" | "agent" | "system";
  sender: string;
  avatarLabel: string | null;
} {
  if (msg.role === "user") {
    const sender = msg.actor || "You";
    return {
      kind: "human",
      sender,
      avatarLabel: sender.slice(0, 1).toUpperCase(),
    };
  }
  if (msg.role === "assistant") {
    return { kind: "agent", sender: "Codevil", avatarLabel: "C" };
  }
  return { kind: "system", sender: "System", avatarLabel: null };
}

function getMessageContent(msg: ChatMessage): string {
  if (msg.variant === "verification_failed" && msg.meta?.last_error) {
    return `${msg.content}\n${msg.meta.last_error}`;
  }
  if (msg.variant === "complete" && msg.meta?.pr_url) {
    return `${msg.content} ${msg.meta.pr_url}`;
  }
  return msg.content;
}

export type TimelineItemData =
  | { id: string; type: "milestone"; data: MilestoneData }
  | { id: string; type: "trace-group"; data: TraceGroupData }
  | { id: string; type: "message"; data: ChatMessage }
  | { id: string; type: "attention"; data: AttentionData };

interface TimelineItemProps {
  item: TimelineItemData;
  highlight?: boolean;
  onOpenActivity?: (id: string) => void;
}

export function TimelineItem({ item, highlight, onOpenActivity }: TimelineItemProps) {
  if (item.type === "milestone") {
    return <MilestoneCard milestone={item.data} />;
  }

  if (item.type === "trace-group") {
    return <TraceGroup group={item.data} onOpenActivity={onOpenActivity} />;
  }

  if (item.type === "attention") {
    return <AttentionCard item={item.data} highlight={highlight} />;
  }

  // message
  const msg = item.data;
  const presentation = getTimelineMessagePresentation(msg);
  const content = getMessageContent(msg);

  if (presentation.kind === "system") {
    return (
      <div className="timeline-system" id={`msg-${msg.id}`}>
        <span className="timeline-system-dot" aria-hidden="true" />
        <span className="timeline-system-content">{content}</span>
        <span className="timeline-system-time">{formatTime(msg.timestamp)}</span>
      </div>
    );
  }

  return (
    <div className={`timeline-msg ${presentation.kind}`} id={`msg-${msg.id}`}>
      <div className={`timeline-msg-avatar ${presentation.kind}`} aria-hidden="true">
        {presentation.avatarLabel}
      </div>
      <div className="timeline-msg-body">
        <div className="timeline-msg-meta">
          <span className="timeline-msg-sender">{presentation.sender}</span>
          <span>·</span>
          <span>{formatTime(msg.timestamp)}</span>
        </div>
        <div className="timeline-msg-bubble">{content}</div>
      </div>
    </div>
  );
}
