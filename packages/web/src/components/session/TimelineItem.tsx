import type { ChatMessage } from "@/types";
import type { CSSProperties } from "react";
import type { QuestionViewModel } from "@/stores/session-store";
import { MilestoneCard, type MilestoneData } from "./MilestoneCard";
import { AttentionCard, type AttentionData } from "./AttentionCard";
import { TraceGroup, type TraceGroupData } from "./TraceGroup";
import { PlanCard } from "./plan-card";
import { QuestionItem } from "./question-card";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function QuestionTimelineItem({ question }: { question: QuestionViewModel }) {
  return (
    <div className="timeline-msg agent" id={`question-${question.requestId}`}>
      <div className="timeline-msg-avatar agent" aria-hidden="true">C</div>
      <div className="timeline-msg-body">
        <div className="timeline-msg-meta">
          <span className="timeline-msg-sender">Codevil</span>
          <span>·</span>
          <span>{formatTime(question.raisedAt)}</span>
        </div>
        <div className="timeline-msg-bubble timeline-msg-bubble--question">
          <QuestionItem question={question} />
        </div>
      </div>
    </div>
  );
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

function isOutgoingMessage(msg: ChatMessage): boolean {
  if (msg.role !== "user") return false;
  return !msg.actor || msg.actor === "You";
}

function renderHumanMessageContent(content: string) {
  const parts = content.split(/(@codevil\b)/gi);
  return parts.map((part, index) => {
    if (part.toLowerCase() === "@codevil") {
      return (
        <span className="timeline-mention" key={`${part}-${index}`}>
          {part}
        </span>
      );
    }
    return part;
  });
}

export type TimelineItemData =
  | { id: string; type: "milestone"; data: MilestoneData }
  | { id: string; type: "trace-group"; data: TraceGroupData }
  | { id: string; type: "message"; data: ChatMessage }
  | { id: string; type: "attention"; data: AttentionData }
  | { id: string; type: "question"; data: QuestionViewModel };

interface TimelineItemProps {
  item: TimelineItemData;
  highlight?: boolean;
  onOpenActivity?: (id: string) => void;
  avatarColors?: Map<string, string>;
  /** True when this message continues a run from the same sender — hides the repeated avatar/meta. */
  grouped?: boolean;
}

export function TimelineItem({ item, highlight, onOpenActivity, avatarColors, grouped }: TimelineItemProps) {
  if (item.type === "milestone") {
    return <MilestoneCard milestone={item.data} />;
  }

  if (item.type === "trace-group") {
    return <TraceGroup group={item.data} onOpenActivity={onOpenActivity} />;
  }

  if (item.type === "attention") {
    return <AttentionCard item={item.data} highlight={highlight} />;
  }

  if (item.type === "question") {
    return <QuestionTimelineItem question={item.data} />;
  }

  // message
  const msg = item.data;
  if (msg.variant === "plan") {
    return <PlanCard />;
  }

  const presentation = getTimelineMessagePresentation(msg);
  const content = getMessageContent(msg);
  const isOutgoing = isOutgoingMessage(msg);
  const avatarColorKey = msg.meta?.actor_id ?? presentation.sender;
  const avatarColor = presentation.kind === "human"
    ? avatarColors?.get(avatarColorKey)
    : undefined;

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
    <div
      className={`timeline-msg ${presentation.kind}${isOutgoing ? " outgoing" : ""}${grouped ? " grouped" : ""}`}
      id={`msg-${msg.id}`}
    >
      <div
        className={`timeline-msg-avatar ${presentation.kind}${grouped ? " is-grouped" : ""}`}
        aria-hidden="true"
        style={avatarColor ? { "--avatar-color": avatarColor } as CSSProperties : undefined}
      >
        {grouped ? null : presentation.avatarLabel}
      </div>
      <div className="timeline-msg-body">
        {!grouped && (
          <div className="timeline-msg-meta">
            <span className="timeline-msg-sender">{presentation.sender}</span>
            <span>·</span>
            <span>{formatTime(msg.timestamp)}</span>
          </div>
        )}
        <div className="timeline-msg-bubble">
          {presentation.kind === "agent" ? (
            <div className="timeline-msg-markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            </div>
          ) : renderHumanMessageContent(content)}
        </div>
      </div>
    </div>
  );
}
