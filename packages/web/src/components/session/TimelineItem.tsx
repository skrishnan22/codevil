import type { ChatMessage } from "@/types";
import { MilestoneCard, type MilestoneData } from "./MilestoneCard";
import { AttentionCard, type AttentionData } from "./AttentionCard";
import { TraceGroup, type TraceGroupData } from "./TraceGroup";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getMessageClass(msg: ChatMessage): string {
  if (msg.role === "user") return "user";
  if (msg.variant === "error" || msg.variant === "verification_failed") return "error";
  if (msg.variant === "complete") return "complete";
  return "agent";
}

function getMessageSender(msg: ChatMessage): string {
  if (msg.role === "user") return "You";
  if (msg.variant === "error") return "Error";
  if (msg.variant === "verification_failed") return "Verification";
  if (msg.variant === "complete") return "Agent";
  return "Agent";
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
  onViewPlan?: () => void;
}

export function TimelineItem({ item, highlight, onViewPlan }: TimelineItemProps) {
  if (item.type === "milestone") {
    return <MilestoneCard milestone={item.data} />;
  }

  if (item.type === "trace-group") {
    return <TraceGroup group={item.data} />;
  }

  if (item.type === "attention") {
    return <AttentionCard item={item.data} highlight={highlight} />;
  }

  // message
  const msg = item.data;
  const cls = getMessageClass(msg);
  const sender = getMessageSender(msg);
  const content = getMessageContent(msg);
  const avatarLabel = cls === "user" ? "U" : "A";

  return (
    <div className={`timeline-msg ${cls}`} id={`msg-${msg.id}`}>
      <div className={`timeline-msg-avatar${cls === "user" ? " user" : ""}`} aria-hidden="true">
        {avatarLabel}
      </div>
      <div className="timeline-msg-body">
        <div className="timeline-msg-meta">
          <span className="timeline-msg-sender">{sender}</span>
          <span>·</span>
          <span>{formatTime(msg.timestamp)}</span>
        </div>
        <div className="timeline-msg-bubble">{content}</div>
      </div>
    </div>
  );
}
